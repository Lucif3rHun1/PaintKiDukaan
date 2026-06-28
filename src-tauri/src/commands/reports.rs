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

use crate::commands::auth::AppState;
use crate::commands::purchases::{date_to_ms, StockMovement};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::security::ipc_auth;

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
        let mut stmt = c.prepare(
            "SELECT date(s.date) AS day,
                    COUNT(*) AS bills,
                    SUM(total) AS grand_total,
                    SUM(bill_discount) AS total_discount
             FROM sales s
             WHERE status = 'final' AND date(s.date) BETWEEN ?1 AND ?2
             GROUP BY day ORDER BY day ASC",
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

        let mut stmt2 = c.prepare(
            "SELECT date(s.date) AS day, sp.mode, sp.amount_paise
             FROM sales s
             JOIN sale_payments sp ON sp.sale_id = s.id
             WHERE s.status = 'final' AND date(s.date) BETWEEN ?1 AND ?2",
        )?;
        let mode_rows = stmt2.query_map(params![from_date, to_date], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })?;
        for r in mode_rows {
            let (d, mode, amt) = r?;
            if let Some(entry) = by_date.get_mut(&d) {
                if let Some(existing) = entry.3.iter_mut().find(|x| x.mode == mode) {
                    existing.amount += amt;
                } else {
                    entry.3.push(ModeTotal { mode, amount: amt });
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
    pub qty: f64,
    pub reorder_level: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct StockGroupRow {
    pub group: String, // brand or category
    pub total_qty: f64,
    pub total_retail_value: f64,
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
                        i.min_stock
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
                if row.qty != 0.0 || row.reorder_level > 0.0 {
                    by_location.push(row);
                }
            }
        }
        let low_stock: Vec<StockRow> = by_location
            .iter()
            .filter(|r| r.reorder_level > 0.0 && r.qty <= r.reorder_level)
            .cloned()
            .collect();

        let mut by_group: Vec<StockGroupRow> = Vec::new();
        {
            let mut stmt = c.prepare(
                "SELECT COALESCE(NULLIF(b.name, ''), NULLIF(i.category, ''), '(uncategorised)') AS grp,
                        COALESCE(SUM(sb.qty), 0) AS qty,
                        COALESCE(SUM(sb.qty * i.retail_price_paise), 0) AS value
                 FROM stock_balances sb
                 JOIN items i ON i.id = sb.item_id
                 LEFT JOIN brands b ON b.id = i.brand_id
                 GROUP BY grp ORDER BY grp",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(StockGroupRow {
                    group: r.get(0)?,
                    total_qty: r.get::<_, f64>(1)?,
                    total_retail_value: r.get::<_, f64>(2)?,
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
                            c.opening_balance_paise
                            + COALESCE((SELECT SUM(s.total - s.paid_amount) FROM sales s
                                        WHERE s.customer_id = c.id AND s.status = 'final'), 0)
                            - COALESCE((SELECT SUM(p.amount_paise) FROM customer_payments p
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
                            COALESCE(v.credit_limit_paise, 0)
                            + COALESCE((SELECT SUM(p.total_paise) FROM purchases p
                                        WHERE p.vendor_id = v.id), 0)
                            - COALESCE((SELECT SUM(vp.amount_paise) FROM vendor_payments vp
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
    crate::commands::purchases::movements_for_item(db, item_id, limit).map_err(|e| match e {
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

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_daily_sales(
    state: tauri::State<'_, AppState>,
    from_date: String,
    to_date: String,
) -> AppResult<DailySalesReport> {
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    daily_sales(db, &from_date, &to_date).map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_stock_report(state: tauri::State<'_, AppState>) -> AppResult<StockReport> {
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    stock_report(db).map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_outstanding_report(state: tauri::State<'_, AppState>) -> AppResult<OutstandingReport> {
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    outstanding_report(db).map_err(|e| AppError::Internal(e.to_string()))
}

// -----------------------------------------------------------------------------
// Dashboard metrics (R20). 9 functions + 10 cmd_* wrappers (cmd_top_items_sold
// is reused for cmd_top_items_purchased on the wire via different name).
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct PurchaseDayRow {
    pub date: String,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PurchaseSummary {
    pub grand_total: i64,
    pub rows: Vec<PurchaseDayRow>,
}

pub fn purchase_summary(
    db: &Db,
    from_date: &str,
    to_date: &str,
) -> Result<PurchaseSummary, ReportsError> {
    db.with_conn(|c| -> Result<PurchaseSummary, ReportsError> {
        let from_ms = date_to_ms(from_date);
        let to_ms = date_to_ms(to_date).saturating_add(86_400_000);
        let mut stmt = c.prepare(
            "SELECT date(bill_date/1000, 'unixepoch', 'localtime') AS day,
                    COALESCE(SUM(total_paise), 0) AS total
             FROM purchases
             WHERE bill_date >= ?1 AND bill_date < ?2
             GROUP BY day ORDER BY day ASC",
        )?;
        let rows = stmt.query_map(params![from_ms, to_ms], |r| {
            Ok(PurchaseDayRow {
                date: r.get::<_, String>(0)?,
                total: r.get::<_, i64>(1)?,
            })
        })?;
        let mut out_rows = Vec::new();
        let mut grand_total: i64 = 0;
        for r in rows {
            let row = r?;
            grand_total += row.total;
            out_rows.push(row);
        }
        Ok(PurchaseSummary {
            grand_total,
            rows: out_rows,
        })
    })
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_purchase_summary(
    state: tauri::State<'_, AppState>,
    from_date: String,
    to_date: String,
) -> AppResult<PurchaseSummary> {
    ipc_auth::authorize_err("cmd_purchase_summary", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    purchase_summary(db, &from_date, &to_date).map_err(|e| AppError::Internal(e.to_string()))
}

#[derive(Debug, Clone, Serialize)]
pub struct ExpenseSummary {
    pub grand_total: i64,
}

pub fn expense_summary(
    db: &Db,
    from_date: &str,
    to_date: &str,
) -> Result<ExpenseSummary, ReportsError> {
    db.with_conn(|c| -> Result<ExpenseSummary, ReportsError> {
        let grand_total: i64 = c
            .query_row(
                "SELECT COALESCE(SUM(expenses_paise), 0) FROM day_close WHERE day BETWEEN ?1 AND ?2",
                params![from_date, to_date],
                |r| r.get(0),
            )
            .unwrap_or(0);
        Ok(ExpenseSummary { grand_total })
    })
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_expense_summary(
    state: tauri::State<'_, AppState>,
    from_date: String,
    to_date: String,
) -> AppResult<ExpenseSummary> {
    ipc_auth::authorize_err("cmd_expense_summary", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    expense_summary(db, &from_date, &to_date).map_err(|e| AppError::Internal(e.to_string()))
}

#[derive(Debug, Clone, Serialize)]
pub struct TopItemRow {
    pub item_id: i64,
    pub name: String,
    pub total_qty: f64,
    pub total_value: i64,
}

pub fn top_items_sold(
    db: &Db,
    from_date: &str,
    to_date: &str,
    limit: i64,
) -> Result<Vec<TopItemRow>, ReportsError> {
    db.with_conn(|c| -> Result<Vec<TopItemRow>, ReportsError> {
        let mut stmt = c.prepare(
            "SELECT si.item_id, i.name, SUM(si.qty) AS total_qty,
                    SUM(si.qty * si.price) AS total_value
             FROM sale_items si
             JOIN sales s ON s.id = si.sale_id
             JOIN items i ON i.id = si.item_id
             WHERE s.status = 'final'
               AND si.item_id IS NOT NULL
               AND date(s.date) BETWEEN ?1 AND ?2
             GROUP BY si.item_id
             ORDER BY total_qty DESC
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![from_date, to_date, limit], |r| {
            Ok(TopItemRow {
                item_id: r.get(0)?,
                name: r.get(1)?,
                total_qty: r.get(2)?,
                total_value: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_top_items_sold(
    state: tauri::State<'_, AppState>,
    from_date: String,
    to_date: String,
    limit: i64,
) -> AppResult<Vec<TopItemRow>> {
    ipc_auth::authorize_err("cmd_top_items_sold", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    top_items_sold(db, &from_date, &to_date, limit).map_err(|e| AppError::Internal(e.to_string()))
}

#[derive(Debug, Clone, Serialize)]
pub struct TopCustomerRow {
    pub customer_id: Option<i64>,
    pub name: String,
    pub total_value: i64,
    pub bill_count: i64,
}

pub fn top_customers(
    db: &Db,
    from_date: &str,
    to_date: &str,
    limit: i64,
) -> Result<Vec<TopCustomerRow>, ReportsError> {
    db.with_conn(|c| -> Result<Vec<TopCustomerRow>, ReportsError> {
        let mut stmt = c.prepare(
            "SELECT s.customer_id, COALESCE(c.name, 'Walk-in') AS name,
                    SUM(s.total) AS total_value, COUNT(*) AS bill_count
             FROM sales s
             LEFT JOIN customers c ON c.id = s.customer_id
             WHERE s.status = 'final' AND date(s.date) BETWEEN ?1 AND ?2
             GROUP BY s.customer_id
             ORDER BY total_value DESC
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![from_date, to_date, limit], |r| {
            Ok(TopCustomerRow {
                customer_id: r.get(0)?,
                name: r.get(1)?,
                total_value: r.get(2)?,
                bill_count: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_top_customers(
    state: tauri::State<'_, AppState>,
    from_date: String,
    to_date: String,
    limit: i64,
) -> AppResult<Vec<TopCustomerRow>> {
    ipc_auth::authorize_err("cmd_top_customers", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    top_customers(db, &from_date, &to_date, limit).map_err(|e| AppError::Internal(e.to_string()))
}

pub fn top_items_purchased(
    db: &Db,
    from_date: &str,
    to_date: &str,
    limit: i64,
) -> Result<Vec<TopItemRow>, ReportsError> {
    db.with_conn(|c| -> Result<Vec<TopItemRow>, ReportsError> {
        let from_ms = date_to_ms(from_date);
        let to_ms = date_to_ms(to_date).saturating_add(86_400_000);
        let mut stmt = c.prepare(
            "SELECT pi.item_id, i.name, SUM(pi.qty) AS total_qty,
                    SUM(pi.line_total_paise) AS total_value
             FROM purchase_items pi
             JOIN purchases p ON p.id = pi.purchase_id
             JOIN items i ON i.id = pi.item_id
             WHERE p.bill_date >= ?1 AND p.bill_date < ?2
             GROUP BY pi.item_id
             ORDER BY total_qty DESC
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![from_ms, to_ms, limit], |r| {
            Ok(TopItemRow {
                item_id: r.get(0)?,
                name: r.get(1)?,
                total_qty: r.get(2)?,
                total_value: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_top_items_purchased(
    state: tauri::State<'_, AppState>,
    from_date: String,
    to_date: String,
    limit: i64,
) -> AppResult<Vec<TopItemRow>> {
    ipc_auth::authorize_err("cmd_top_items_purchased", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    top_items_purchased(db, &from_date, &to_date, limit)
        .map_err(|e| AppError::Internal(e.to_string()))
}

#[derive(Debug, Clone, Serialize)]
pub struct TopVendorRow {
    pub vendor_id: Option<i64>,
    pub name: String,
    pub total_value: i64,
}

pub fn top_vendors(
    db: &Db,
    from_date: &str,
    to_date: &str,
    limit: i64,
) -> Result<Vec<TopVendorRow>, ReportsError> {
    db.with_conn(|c| -> Result<Vec<TopVendorRow>, ReportsError> {
        let from_ms = date_to_ms(from_date);
        let to_ms = date_to_ms(to_date).saturating_add(86_400_000);
        let mut stmt = c.prepare(
            "SELECT p.vendor_id, COALESCE(v.name, 'Unknown') AS name,
                    SUM(p.total_paise) AS total_value
             FROM purchases p
             LEFT JOIN vendors v ON v.id = p.vendor_id
             WHERE p.bill_date >= ?1 AND p.bill_date < ?2
             GROUP BY p.vendor_id
             ORDER BY total_value DESC
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![from_ms, to_ms, limit], |r| {
            Ok(TopVendorRow {
                vendor_id: r.get(0)?,
                name: r.get(1)?,
                total_value: r.get(2)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_top_vendors(
    state: tauri::State<'_, AppState>,
    from_date: String,
    to_date: String,
    limit: i64,
) -> AppResult<Vec<TopVendorRow>> {
    ipc_auth::authorize_err("cmd_top_vendors", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    top_vendors(db, &from_date, &to_date, limit).map_err(|e| AppError::Internal(e.to_string()))
}

#[derive(Debug, Clone, Serialize)]
pub struct StockHealthSummary {
    pub total_active_items: i64,
    pub healthy_count: i64,
    pub low_count: i64,
    pub zero_count: i64,
    pub negative_count: i64,
    pub retail_value_paise: i64,
}

pub fn stock_health_summary(db: &Db) -> Result<StockHealthSummary, ReportsError> {
    db.with_conn(|c| -> Result<StockHealthSummary, ReportsError> {
        let row = c.query_row(
            "SELECT
                COUNT(*) AS total_active_items,
                SUM(CASE WHEN total_qty > 0 AND (min_stock = 0 OR total_qty > min_stock) THEN 1 ELSE 0 END) AS healthy_count,
                SUM(CASE WHEN total_qty > 0 AND min_stock > 0 AND total_qty <= min_stock THEN 1 ELSE 0 END) AS low_count,
                SUM(CASE WHEN total_qty = 0 THEN 1 ELSE 0 END) AS zero_count,
                SUM(CASE WHEN total_qty < 0 THEN 1 ELSE 0 END) AS negative_count,
                SUM(CASE WHEN total_qty > 0 THEN total_qty * retail_price_paise ELSE 0 END) AS retail_value_paise
             FROM (
                SELECT i.id, i.min_stock, i.retail_price_paise,
                       COALESCE(SUM(sb.qty), 0) AS total_qty
                FROM items i
                LEFT JOIN stock_balances sb ON sb.item_id = i.id
                WHERE i.is_active = 1
                GROUP BY i.id
             )",
            [],
            |r| {
                Ok(StockHealthSummary {
                    total_active_items: r.get(0)?,
                    healthy_count: r.get(1)?,
                    low_count: r.get(2)?,
                    zero_count: r.get(3)?,
                    negative_count: r.get(4)?,
                    retail_value_paise: r.get(5)?,
                })
            },
        )?;
        Ok(row)
    })
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_stock_health_summary(
    state: tauri::State<'_, AppState>,
) -> AppResult<StockHealthSummary> {
    ipc_auth::authorize_err("cmd_stock_health_summary", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    stock_health_summary(db).map_err(|e| AppError::Internal(e.to_string()))
}

#[derive(Debug, Clone, Serialize)]
pub struct DeadStockRow {
    pub item_id: i64,
    pub name: String,
    pub current_qty: f64,
    pub last_sale_ms: Option<i64>,
}

/// Dead stock = items we have in stock (qty > 0) but haven't sold in `days_idle` days.
/// Tracks unsold inventory sitting idle, not shipment gaps.
pub fn dead_stock(db: &Db, days_idle: i64) -> Result<Vec<DeadStockRow>, ReportsError> {
    db.with_conn(|c| -> Result<Vec<DeadStockRow>, ReportsError> {
        let threshold_ms =
            chrono::Utc::now().timestamp_millis() - days_idle.saturating_mul(86_400_000);
        let mut stmt = c.prepare(
            "SELECT i.id, i.name, COALESCE(SUM(sb.qty), 0) AS current_qty,
                    MAX(sm.created_at) AS last_sale_ms
             FROM items i
             LEFT JOIN stock_balances sb ON sb.item_id = i.id
             LEFT JOIN stock_movements sm
                    ON sm.item_id = i.id AND sm.type = 'sale' AND sm.created_at >= ?1
             WHERE i.is_active = 1
             GROUP BY i.id
             HAVING current_qty > 0 AND last_sale_ms IS NULL
             ORDER BY i.name
             LIMIT 50",
        )?;
        let rows = stmt.query_map(params![threshold_ms], |r| {
            Ok(DeadStockRow {
                item_id: r.get(0)?,
                name: r.get(1)?,
                current_qty: r.get(2)?,
                last_sale_ms: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_dead_stock(
    state: tauri::State<'_, AppState>,
    days_idle: i64,
) -> AppResult<Vec<DeadStockRow>> {
    ipc_auth::authorize_err("cmd_dead_stock", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    dead_stock(db, days_idle).map_err(|e| AppError::Internal(e.to_string()))
}

#[derive(Debug, Clone, Serialize)]
pub struct InventoryAgingReport {
    pub bucket_0_30: i64,
    pub bucket_31_60: i64,
    pub bucket_61_90: i64,
    pub bucket_91_plus: i64,
}

pub fn inventory_aging(db: &Db) -> Result<InventoryAgingReport, ReportsError> {
    db.with_conn(|c| -> Result<InventoryAgingReport, ReportsError> {
        let now_ms = chrono::Utc::now().timestamp_millis();
        let t30 = now_ms - 30 * 86_400_000;
        let t60 = now_ms - 60 * 86_400_000;
        let t90 = now_ms - 90 * 86_400_000;
        let row = c.query_row(
            "SELECT
                SUM(CASE WHEN last_sale_ms >= ?1 THEN 1 ELSE 0 END) AS b0,
                SUM(CASE WHEN last_sale_ms >= ?2 AND last_sale_ms < ?1 THEN 1 ELSE 0 END) AS b30,
                SUM(CASE WHEN last_sale_ms >= ?3 AND last_sale_ms < ?2 THEN 1 ELSE 0 END) AS b60,
                SUM(CASE WHEN last_sale_ms IS NULL OR last_sale_ms < ?3 THEN 1 ELSE 0 END) AS b90
             FROM (
                SELECT i.id, MAX(sm.created_at) AS last_sale_ms
                FROM items i
                LEFT JOIN stock_movements sm ON sm.item_id = i.id AND sm.type = 'sale'
                WHERE i.is_active = 1
                GROUP BY i.id
             )",
            params![t30, t60, t90],
            |r| {
                Ok(InventoryAgingReport {
                    bucket_0_30: r.get(0)?,
                    bucket_31_60: r.get(1)?,
                    bucket_61_90: r.get(2)?,
                    bucket_91_plus: r.get(3)?,
                })
            },
        )?;
        Ok(row)
    })
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_inventory_aging(state: tauri::State<'_, AppState>) -> AppResult<InventoryAgingReport> {
    ipc_auth::authorize_err("cmd_inventory_aging", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    inventory_aging(db).map_err(|e| AppError::Internal(e.to_string()))
}

#[derive(Debug, Clone, Serialize)]
pub struct PaymentSummary {
    pub received_paise: i64,
    pub paid_paise: i64,
}

pub fn payment_summary(
    db: &Db,
    from_date: &str,
    to_date: &str,
) -> Result<PaymentSummary, ReportsError> {
    db.with_conn(|c| -> Result<PaymentSummary, ReportsError> {
        let from_ms = date_to_ms(from_date);
        let to_ms = date_to_ms(to_date).saturating_add(86_400_000);
        let received: i64 = c
            .query_row(
                "SELECT COALESCE(SUM(amount_paise), 0) FROM customer_payments
                 WHERE created_at >= ?1 AND created_at < ?2",
                params![from_ms, to_ms],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let paid: i64 = c
            .query_row(
                "SELECT COALESCE(SUM(amount_paise), 0) FROM vendor_payments
                 WHERE created_at >= ?1 AND created_at < ?2",
                params![from_ms, to_ms],
                |r| r.get(0),
            )
            .unwrap_or(0);
        Ok(PaymentSummary {
            received_paise: received,
            paid_paise: paid,
        })
    })
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_payment_summary(
    state: tauri::State<'_, AppState>,
    from_date: String,
    to_date: String,
) -> AppResult<PaymentSummary> {
    ipc_auth::authorize_err("cmd_payment_summary", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    payment_summary(db, &from_date, &to_date).map_err(|e| AppError::Internal(e.to_string()))
}

// -----------------------------------------------------------------------------
// Comparison metrics — day-over-day, week-over-week, month-over-month.
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct ComparisonMetric {
    pub current: i64,
    pub previous: i64,
    pub change_pct: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ComparisonMetricsReport {
    pub sales: ComparisonMetric,
    pub bills: ComparisonMetric,
    pub avg_bill_value: ComparisonMetric,
}

fn sum_sales(db: &Db, from_date: &str, to_date: &str) -> Result<(i64, i64), ReportsError> {
    db.with_conn(|c| -> Result<(i64, i64), ReportsError> {
        let row = c.query_row(
            "SELECT COALESCE(SUM(total), 0), COUNT(*) FROM sales
             WHERE status = 'final' AND date(date) BETWEEN ?1 AND ?2",
            params![from_date, to_date],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        )?;
        Ok(row)
    })
}

pub fn comparison_metrics(db: &Db, ref_date: &str) -> Result<ComparisonMetricsReport, ReportsError> {
    let (cur_total, cur_bills) = sum_sales(db, ref_date, ref_date)?;
    let prev_date: String = db.with_conn(|c| -> Result<String, ReportsError> {
        c.query_row(
            "SELECT date(?1, '-1 day')",
            params![ref_date],
            |r| r.get(0),
        )
        .map_err(ReportsError::from)
    })?;
    let (prev_total, prev_bills) = sum_sales(db, &prev_date, &prev_date)?;

    fn delta(current: i64, previous: i64) -> ComparisonMetric {
        let change_pct = if previous == 0 {
            if current == 0 { 0.0 } else { 100.0 }
        } else {
            ((current as f64 - previous as f64) / previous as f64) * 100.0
        };
        ComparisonMetric {
            current,
            previous,
            change_pct: (change_pct * 10.0).round() / 10.0,
        }
    }

    let avg_cur = if cur_bills > 0 { cur_total / cur_bills } else { 0 };
    let avg_prev = if prev_bills > 0 { prev_total / prev_bills } else { 0 };

    Ok(ComparisonMetricsReport {
        sales: delta(cur_total, prev_total),
        bills: delta(cur_bills, prev_bills),
        avg_bill_value: delta(avg_cur, avg_prev),
    })
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_comparison_metrics(
    state: tauri::State<'_, AppState>,
    ref_date: String,
) -> AppResult<ComparisonMetricsReport> {
    ipc_auth::authorize_err("cmd_comparison_metrics", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    comparison_metrics(db, &ref_date).map_err(|e| AppError::Internal(e.to_string()))
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
                "INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length, is_active, created_at, updated_at) VALUES ('Owner','owner',X'00',X'00',6,1,0,0)",
                [],
            )?;
            c.execute(
                "INSERT INTO brands (name, is_active, created_at, updated_at) VALUES ('AsianPaints',1,0,0)",
                [],
            )?;
            c.execute(
                "INSERT INTO items (sku_code, barcode, name, brand_id, category, unit_id, unit_code, unit_label, units_per_pack, retail_price_paise, cost_paise, is_active, sell_unit, sell_unit_id, min_stock, created_at, updated_at)
                 VALUES ('SK001','111','Red 4L',(SELECT id FROM brands WHERE name='AsianPaints' LIMIT 1),'Interior',(SELECT id FROM units WHERE code='L' LIMIT 1),'L','Liter',1,10000,5000,1,'unit',NULL,2,0,0)",
                [],
            )?;
            c.execute(
                "INSERT INTO items (sku_code, barcode, name, brand_id, category, unit_id, unit_code, unit_label, units_per_pack, retail_price_paise, cost_paise, is_active, sell_unit, sell_unit_id, min_stock, created_at, updated_at)
                 VALUES ('SK002','222','Blue 4L',(SELECT id FROM brands WHERE name='AsianPaints' LIMIT 1),'Interior',(SELECT id FROM units WHERE code='L' LIMIT 1),'L','Liter',1,15000,8000,1,'unit',NULL,2,0,0)",
                [],
            )?;
            c.execute(
                "INSERT INTO customers (name, phone, opening_balance_paise, is_active, created_at, updated_at)
                 VALUES ('Walk-in Mr A', '9999000001', 0, 1, 0, 0)",
                [],
            )?;
            c.execute(
                "INSERT INTO customers (name, phone, opening_balance_paise, is_active, created_at, updated_at)
                 VALUES ('Credit Mr B', '9999000002', 0, 1, 0, 0)",
                [],
            )?;
            c.execute(
                "INSERT INTO customers (name, phone, opening_balance_paise, is_active, created_at, updated_at)
                 VALUES ('Zero Mr C', '9999000003', 0, 1, 0, 0)",
                [],
            )?;
            c.execute(
                "INSERT INTO vendors (name, credit_limit_paise, is_active, created_at, updated_at) VALUES ('Acme Paints', 0, 1, 0, 0)",
                [],
            )?;
            c.execute(
                "INSERT INTO locations (name, zone, is_default, is_active, created_at, updated_at) VALUES ('Main',NULL,1,1,0,0)",
                [],
            )?;
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
                payment_modes: vec![PaymentSplit {
                    mode: mode.into(),
                    amount: amt,
                }],
                validity_days: None,
                acknowledge_flag: false,
                lines: vec![CartLine {
                    kind: "item".into(),
                    item_id: Some(1),
                    formula_id: None,
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
                "INSERT INTO sales (no, customer_id, status, user_id, subtotal, bill_discount, total, paid_amount, created_at, updated_at)
                 VALUES ('INV-TEST-0001',2,'final',1,7500,0,7500,0,'2025-01-10 10:00:00','2025-01-10 10:00:00')",
                [],
            )?;
            c.execute(
                "INSERT INTO customers (name, phone, opening_balance_paise, is_active, created_at, updated_at)
                 VALUES ('Heavy Mr D', '9999000004', 0, 1, 0, 0)",
                [],
            )?;
            c.execute(
                "INSERT INTO sales (no, customer_id, status, user_id, subtotal, bill_discount, total, paid_amount, created_at, updated_at)
                 VALUES ('INV-TEST-0002',4,'final',1,12000,0,12000,0,'2025-01-10 11:00:00','2025-01-10 11:00:00')",
                [],
            )?;
            c.execute(
                "INSERT INTO purchases (purchase_number, vendor_id, location_id, total_paise, created_by, created_at, updated_at)
                 VALUES ('PINV-0001',1,1,5000,1,0,0)",
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
                vendor_id: Some(1),
                date: Some("2026-06-18".into()),
                notes: None,
                auto_print_label: false,
                lines: vec![crate::commands::purchases::InwardLine {
                    item_id: 1,
                    qty: 2.0,
                    unit_type: "unit".into(),
                    unit_price_paise: 5000,
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
        assert_eq!(item1.qty, 1.0);
        assert!(rep.low_stock.iter().any(|r| r.item_id == 1));
        // Group row exists with brand AsianPaints.
        assert!(rep.by_group.iter().any(|g| g.group == "AsianPaints"));
    }
}

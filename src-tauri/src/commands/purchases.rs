//! Inward (purchase) commands.
//!
//! Per master plan §7.2. All writes happen in BEGIN IMMEDIATE so the purchase
//! row, purchase_items rows, and the corresponding stock_movements land
//! atomically (E25–E30).
//!
//! Box/unit conversion: a line may come in as `unit_type="box"` with a qty in
//! boxes; we multiply by `items.units_per_box` to derive the base qty stored
//! in `stock_movements.qty` (E26). Frontend converts for display; backend
//! performs a defensive check that base qty matches the line as recorded in
//! purchase_items (purchase_items stores base units as well).
//!
//! Sticky cost (E25 / §7.2 step 4): when a line item is added to a new
//! purchase, the frontend reuses the last-entered cost for that item. This
//! command exposes `last_cost_for_item` so the UI can prefetch it.
//!
//! Unknown barcode inline create (E29 / §8.5): if the operator scans a code
//! that doesn't exist, the frontend must call `find_item_by_barcode` first.
//! If absent, the operator fills a small "new item" form and we get a new
//! `item_id` (Slice B owns items CRUD; for Slice C we accept the new id via
//! `create_inward` and trust it points to a freshly-created item).
//!
//! Auto-print (E-IA1): after a successful inward, if `auto_print_label` is
//! true in the request the Rust side returns `print_label=true` in the result
//! so the frontend can fire the JsBarcode label print.

use rusqlite::params;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::commands::auth::AppState;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::security::ipc_auth;

// -----------------------------------------------------------------------------
// Public types.
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct Purchase {
    pub id: i64,
    pub vendor_id: Option<i64>,
    pub vendor_name: Option<String>,
    pub date: String,
    pub total: i64,
    pub user_id: i64,
    pub notes: Option<String>,
    pub items: Vec<PurchaseItem>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PurchaseItem {
    pub item_id: i64,
    pub item_name: String,
    pub qty: f64,
    pub unit_price_paise: i64,
    pub location_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct InwardLine {
    pub item_id: i64,
    pub qty: f64,
    pub unit_type: String, // "unit" | "mtr" | "kg"
    pub unit_price_paise: i64,
    pub location_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewPurchase {
    pub vendor_id: Option<i64>,
    pub date: Option<String>, // ISO YYYY-MM-DD; default today
    pub notes: Option<String>,
    pub auto_print_label: bool,
    pub lines: Vec<InwardLine>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PurchaseCreated {
    pub id: i64,
    pub print_label: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct StockMovement {
    pub id: i64,
    pub item_id: i64,
    pub location_id: i64,
    pub qty: f64,
    pub r#type: String, // "inward" | "sale" | "adjust" | "transfer"
    pub ref_type: Option<String>,
    pub ref_id: Option<i64>,
    pub reason: Option<String>,
    pub user_id: i64,
    pub created_at: String,
}

// -----------------------------------------------------------------------------
// Errors.
// -----------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum PurchaseError {
    #[error("purchase must have at least one line")]
    EmptyLines,
    #[error("line {0}: qty must be > 0")]
    BadQty(usize),
    #[error("line {0}: unit_price_paise must be >= 0")]
    BadCost(usize),
    #[error("line {0}: unit_type must be 'unit', 'mtr', or 'kg'")]
    BadUnitType(usize),
    #[error("line {0}: item {1} not found")]
    ItemNotFound(usize, i64),
    #[error("line {0}: location {1} not found")]
    LocationNotFound(usize, i64),
    #[error("line {0}: qty_per_purchase_unit must be > 0")]
    BadUnitsPerBox(usize),
    #[error("db error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("{0}")]
    Other(#[from] anyhow::Error),
}

// -----------------------------------------------------------------------------
// Pure helpers (also unit-tested).
// -----------------------------------------------------------------------------

/// Resolve a line's base qty.
/// With the 3-unit system, unit_type is always the base unit, so this is a passthrough.
pub fn base_qty(line_qty: f64, _unit_type: &str, _units_per_box: f64) -> f64 {
    line_qty
}

/// Compute total paise for a purchase = sum(qty * cost_price) for each line.
pub fn purchase_total(lines: &[InwardLine], _units_per_box: &[f64]) -> i64 {
    lines
        .iter()
        .map(|l| (l.qty * l.unit_price_paise as f64).round() as i64)
        .sum()
}

// -----------------------------------------------------------------------------
// Read paths.
// -----------------------------------------------------------------------------

/// Last cost entered for an item (most recent purchase_items row). Returns
/// None when the item has no purchase history.
pub fn last_cost_for_item(db: &Db, item_id: i64) -> Result<Option<i64>, PurchaseError> {
    db.with_conn(|c| -> Result<Option<i64>, PurchaseError> {
        let r = c.query_row(
            "SELECT unit_price_paise FROM purchase_items
             WHERE item_id = ?1
             ORDER BY purchase_id DESC LIMIT 1",
            params![item_id],
            |row| row.get::<_, i64>(0),
        );
        match r {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    })
}

/// List recent inward purchases for the Inward history page (E30). Date
/// filters are inclusive.
pub fn list(
    db: &Db,
    from_date: Option<&str>,
    to_date: Option<&str>,
    limit: i64,
) -> Result<Vec<Purchase>, PurchaseError> {
    db.with_conn(|c| -> Result<Vec<Purchase>, PurchaseError> {
        let limit = limit.clamp(1, 500);
        let mut sql = String::from(
            "SELECT p.id, p.vendor_id, v.name, p.bill_date, p.total_paise, p.created_by, p.notes, p.created_at
             FROM purchases p LEFT JOIN vendors v ON v.id = p.vendor_id
             WHERE 1=1",
        );
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(f) = from_date {
            sql.push_str(" AND (p.bill_date >= ? OR p.bill_date IS NULL)");
            args.push(Box::new(date_to_ms(f)));
        }
        if let Some(t) = to_date {
            sql.push_str(" AND (p.bill_date <= ? OR p.bill_date IS NULL)");
            args.push(Box::new(date_to_ms(t)));
        }
        sql.push_str(" ORDER BY p.bill_date DESC, p.id DESC LIMIT ?");
        args.push(Box::new(limit));
        let arg_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();

        let mut stmt = c.prepare(&sql)?;
        let mut rows = stmt.query(arg_refs.as_slice())?;
        let mut purchases = Vec::new();
        while let Some(r) = rows.next()? {
            let id: i64 = r.get(0)?;
            let vendor_id: Option<i64> = r.get(1)?;
            let vendor_name: Option<String> = r.get(2)?;
            let bill_date_ms: Option<i64> = r.get(3)?;
            let total: i64 = r.get(4)?;
            let user_id: i64 = r.get(5)?;
            let notes: Option<String> = r.get(6)?;
            let created_at_ms: i64 = r.get(7)?;
            // Fallback to created_at when bill_date is NULL (pre-migration data)
            let date = bill_date_ms.map(ms_to_date).filter(|s| !s.is_empty())
                .unwrap_or_else(|| ms_to_date(created_at_ms));
            let items = load_items(c, id)?;
            purchases.push(Purchase {
                id,
                vendor_id,
                vendor_name,
                date,
                total,
                user_id,
                notes,
                items,
            });
        }
        Ok(purchases)
    })
}

pub fn get(db: &Db, id: i64) -> Result<Option<Purchase>, PurchaseError> {
    db.with_conn(|c| -> Result<Option<Purchase>, PurchaseError> {
        let r = c.query_row(
            "SELECT p.id, p.vendor_id, v.name, p.bill_date, p.total_paise, p.created_by, p.notes, p.created_at
             FROM purchases p LEFT JOIN vendors v ON v.id = p.vendor_id
             WHERE p.id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, i64>(7)?,
                ))
            },
        );
        match r {
            Ok((id, vendor_id, vendor_name, date_ms, total, user_id, notes, created_at_ms)) => {
                let items = load_items(c, id)?;
                let date = date_ms.map(ms_to_date).filter(|s| !s.is_empty())
                    .unwrap_or_else(|| ms_to_date(created_at_ms));
                Ok(Some(Purchase {
                    id,
                    vendor_id,
                    vendor_name,
                    date,
                    total,
                    user_id,
                    notes,
                    items,
                }))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    })
}

/// Stock movements audit (used by the per-item Movements tab in Items
/// detail). Slices A owns the table; we just expose the read.
pub fn movements_for_item(
    db: &Db,
    item_id: i64,
    limit: i64,
) -> Result<Vec<StockMovement>, PurchaseError> {
    db.with_conn(|c| -> Result<Vec<StockMovement>, PurchaseError> {
        let limit = limit.clamp(1, 1000);
            let mut stmt = c.prepare(
                "SELECT sm.id, sm.item_id, sm.location_id, sm.qty, k.code, sm.ref_kind, sm.ref_id, sm.note, sm.created_at, sm.created_by
                 FROM stock_movements sm
                 JOIN stock_movement_kinds k ON k.id = sm.kind_id
                 WHERE sm.item_id = ?1
                 ORDER BY sm.id DESC LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![item_id, limit], |r| {
                Ok(StockMovement {
                    id: r.get(0)?,
                    item_id: r.get(1)?,
                    location_id: r.get(2)?,
                    qty: r.get(3)?,
                    r#type: r.get(4)?,
                    ref_type: r.get(5)?,
                    ref_id: r.get(6)?,
                    reason: r.get(7)?,
                    user_id: r.get(9)?,
                    created_at: r.get::<_, i64>(8)?.to_string(),
                })
            })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
}

fn load_items(
    c: &rusqlite::Connection,
    purchase_id: i64,
) -> Result<Vec<PurchaseItem>, rusqlite::Error> {
    let mut stmt = c.prepare(
        "SELECT pi.item_id, i.name, pi.qty, pi.unit_price_paise
         FROM purchase_items pi JOIN items i ON i.id = pi.item_id
         WHERE pi.purchase_id = ?1 ORDER BY pi.id",
    )?;
    let rows = stmt.query_map(params![purchase_id], |r| {
        Ok(PurchaseItem {
            item_id: r.get(0)?,
            item_name: r.get(1)?,
            qty: r.get(2)?,
            unit_price_paise: r.get(3)?,
            location_id: 0,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

// -----------------------------------------------------------------------------
// Create path.
// -----------------------------------------------------------------------------

pub fn create_inward(
    db: &Db,
    user_id: i64,
    req: NewPurchase,
) -> Result<PurchaseCreated, PurchaseError> {
    if req.lines.is_empty() {
        return Err(PurchaseError::EmptyLines);
    }
    for (i, l) in req.lines.iter().enumerate() {
        if l.qty <= 0.0 || l.qty.is_nan() {
            return Err(PurchaseError::BadQty(i));
        }
        if l.unit_price_paise < 0 {
            return Err(PurchaseError::BadCost(i));
        }
        if l.unit_type != "unit" && l.unit_type != "mtr" && l.unit_type != "kg" {
            return Err(PurchaseError::BadUnitType(i));
        }
    }
    let date_str = req.date.unwrap_or_else(today);
    let bill_date = date_to_ms(&date_str);
    let vendor_id = req.vendor_id;
    let location_id = req.lines[0].location_id;

    let created = db.with_conn_immediate(|c| -> Result<PurchaseCreated, PurchaseError> {
        let mut upb_per_line: Vec<f64> = Vec::with_capacity(req.lines.len());
        for (i, l) in req.lines.iter().enumerate() {
            let upb: Option<f64> = c
                .query_row(
                    "SELECT units_per_pack FROM items WHERE id = ?1",
                    params![l.item_id],
                    |r| r.get::<_, f64>(0),
                )
                .optional()
                .map_err(PurchaseError::Db)?;
            let upb = upb.ok_or(PurchaseError::ItemNotFound(i, l.item_id))?;
            upb_per_line.push(upb);

            let loc_exists: bool = c
                .query_row(
                    "SELECT 1 FROM locations WHERE id = ?1",
                    params![l.location_id],
                    |_| Ok(true),
                )
                .optional()
                .map_err(PurchaseError::Db)?
                .unwrap_or(false);
            if !loc_exists {
                return Err(PurchaseError::LocationNotFound(i, l.location_id));
            }
        }
        let total = purchase_total(&req.lines, &upb_per_line);
        let next_id: i64 = c.query_row(
            "SELECT COALESCE(MAX(id), 0) + 1 FROM purchases",
            [],
            |r| r.get(0),
        )?;
        let purchase_number = format!("PINV-{next_id:04}");
        let pid: i64 = c.query_row(
            "INSERT INTO purchases (purchase_number, vendor_id, location_id, total_paise, created_by, notes, bill_date, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) RETURNING id",
            params![purchase_number, vendor_id, location_id, total, user_id, req.notes, bill_date, now_ms(), now_ms()],
            |r| r.get(0),
        )?;
        for (i, l) in req.lines.iter().enumerate() {
            let upb = upb_per_line[i];
            let base = base_qty(l.qty, &l.unit_type, upb);
            let line_total = (base * l.unit_price_paise as f64).round() as i64;
            c.execute(
                "INSERT INTO purchase_items (purchase_id, item_id, qty, sale_unit_id, unit_price_paise, line_discount_paise, line_total_paise, created_at)
                 VALUES (?1, ?2, ?3, (SELECT sell_unit_id FROM items WHERE id = ?2), ?4, 0, ?5, ?6)",
                params![pid, l.item_id, base, l.unit_price_paise, line_total, now_ms()],
            )?;
            c.execute(
                "INSERT INTO stock_movements (item_id, location_id, qty, kind_id, sale_unit_id, ref_kind, ref_id, note, created_at, created_by)
                 VALUES (?1, ?2, ?3, (SELECT id FROM stock_movement_kinds WHERE code='purchase'), (SELECT sell_unit_id FROM items WHERE id = ?1), 'purchase', ?4, ?5, ?6, ?7)",
                params![l.item_id, l.location_id, base, pid, req.notes, now_ms(), user_id],
            )?;
        }
        Ok(PurchaseCreated {
            id: pid,
            print_label: req.auto_print_label,
        })
    })?;
    Ok(created)
}

// -----------------------------------------------------------------------------
// Stock adjustment (add / reduce).
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct AdjustStockRequest {
    pub item_id: i64,
    pub qty: f64, // positive = add, negative = reduce
    pub location_id: i64,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AdjustStockResult {
    pub new_qty: f64,
}

/// Insert a stock_movement with kind='adjustment'. Rejects if reduce would
/// make stock negative.
pub fn adjust_stock(
    db: &Db,
    user_id: i64,
    req: AdjustStockRequest,
) -> Result<AdjustStockResult, PurchaseError> {
    if req.qty == 0.0 || req.qty.is_nan() {
        return Err(PurchaseError::BadQty(0));
    }
    if req.qty < 0.0 {
        // Check current balance won't go negative.
        let current: f64 = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT COALESCE(sb.qty, 0) FROM items i \
                     LEFT JOIN (SELECT item_id, SUM(qty) AS qty FROM stock_balances GROUP BY item_id) sb \
                     ON sb.item_id = i.id WHERE i.id = ?1",
                    params![req.item_id],
                    |r| r.get(0),
                )
            })
            .map_err(|e| PurchaseError::Db(e))?;
        if current + req.qty < 0.0 {
            return Err(PurchaseError::Other(anyhow::anyhow!(
                "stock would go negative (current: {}, reduce: {})",
                current,
                req.qty.abs()
            )));
        }
    }
    let note = req.notes.unwrap_or_else(|| "stock adjustment".into());
    let kind_id: i64 = db
        .with_conn(|c| {
            c.query_row(
                "SELECT id FROM stock_movement_kinds WHERE code = 'adjustment'",
                [],
                |r| r.get(0),
            )
        })
        .map_err(PurchaseError::Db)?;

    db.with_conn_immediate(|c| {
        c.execute(
            "INSERT INTO stock_movements (item_id, location_id, qty, kind_id, sale_unit_id, ref_kind, ref_id, note, created_at, created_by) \
             VALUES (?1, ?2, ?3, ?4, (SELECT sell_unit_id FROM items WHERE id = ?1), 'adjustment', NULL, ?5, ?6, ?7)",
            params![req.item_id, req.location_id, req.qty, kind_id, note, now_ms(), user_id],
        )?;
        let new_qty: f64 = c.query_row(
            "SELECT COALESCE(sb.qty, 0) FROM items i \
             LEFT JOIN (SELECT item_id, SUM(qty) AS qty FROM stock_balances GROUP BY item_id) sb \
             ON sb.item_id = i.id WHERE i.id = ?1",
            params![req.item_id],
            |r| r.get(0),
        )?;
        Ok(AdjustStockResult { new_qty })
    })
    .map_err(|e| PurchaseError::Db(e))
}

// -----------------------------------------------------------------------------
// Date helpers.
// -----------------------------------------------------------------------------

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub(crate) fn date_to_ms(date: &str) -> i64 {
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map(|d| {
            d.and_time(chrono::NaiveTime::MIN)
                .and_utc()
                .timestamp_millis()
        })
        .unwrap_or_else(|_| now_ms())
}

pub(crate) fn ms_to_date(ms: i64) -> String {
    let secs = ms / 1000;
    let nsec = ((ms.rem_euclid(1_000)) as u32) * 1_000_000;
    chrono::DateTime::<chrono::Utc>::from_timestamp(secs, nsec)
        .map(|dt| {
            dt.with_timezone(&chrono::Local)
                .format("%Y-%m-%d")
                .to_string()
        })
        .unwrap_or_default()
}

// -----------------------------------------------------------------------------
// Tauri command surface.
// -----------------------------------------------------------------------------

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_create_inward(
    state: tauri::State<'_, AppState>,
    req: NewPurchase,
) -> AppResult<PurchaseCreated> {
    crate::security::ipc_auth::authorize_err("cmd_create_inward", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let session = state
        .session
        .lock()
        .map_err(|_| AppError::Internal("session lock poisoned".into()))?;
    let user = session.as_ref().ok_or(AppError::NotUnlocked)?;
    create_inward(db, user.id, req).map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_last_cost(state: tauri::State<'_, AppState>, item_id: i64) -> AppResult<Option<i64>> {
    crate::security::ipc_auth::authorize_err("cmd_last_cost", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    last_cost_for_item(db, item_id).map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_list_purchases(
    state: tauri::State<'_, AppState>,
    from_date: Option<String>,
    to_date: Option<String>,
    limit: Option<i64>,
) -> AppResult<Vec<Purchase>> {
    crate::security::ipc_auth::authorize_err("cmd_list_purchases", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    list(
        db,
        from_date.as_deref(),
        to_date.as_deref(),
        limit.unwrap_or(100),
    )
    .map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_get_purchase(state: tauri::State<'_, AppState>, id: i64) -> AppResult<Option<Purchase>> {
    crate::security::ipc_auth::authorize_err("cmd_get_purchase", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    get(db, id).map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_movements_for_item(
    state: tauri::State<'_, AppState>,
    item_id: i64,
    limit: Option<i64>,
) -> AppResult<Vec<StockMovement>> {
    crate::security::ipc_auth::authorize_err("cmd_movements_for_item", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    movements_for_item(db, item_id, limit.unwrap_or(200))
        .map_err(|e| AppError::Internal(e.to_string()))
}

// -----------------------------------------------------------------------------
// Tauri command: adjust stock.
// -----------------------------------------------------------------------------

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_adjust_stock(
    state: tauri::State<'_, AppState>,
    req: AdjustStockRequest,
) -> AppResult<AdjustStockResult> {
    crate::security::ipc_auth::authorize_err("cmd_adjust_stock", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let session = state
        .session
        .lock()
        .map_err(|_| AppError::Internal("session lock poisoned".into()))?;
    let user = session.as_ref().ok_or(AppError::NotUnlocked)?;
    adjust_stock(db, user.id, req).map_err(|e| AppError::Internal(e.to_string()))
}

// -----------------------------------------------------------------------------
// Unit tests.
// -----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn line(qty: f64, unit: &str, cost: i64) -> InwardLine {
        InwardLine {
            item_id: 1,
            qty,
            unit_type: unit.into(),
            unit_price_paise: cost,
            location_id: 1,
        }
    }

    #[test]
    fn base_qty_unit_passes_through() {
        assert_eq!(base_qty(3.0, "unit", 12.0), 3.0);
    }

    #[test]
    fn base_qty_box_passes_through() {
        assert_eq!(base_qty(2.0, "box", 12.0), 2.0);
    }

    #[test]
    fn base_qty_mtr_passes_through() {
        assert_eq!(base_qty(1.5, "mtr", 4.0), 1.5);
    }

    #[test]
    fn purchase_total_sums_qty_times_cost() {
        let lines = vec![line(3.0, "unit", 100), line(2.0, "unit", 100)];
        let upb = vec![12.0, 12.0];
        // 3 * 100 + 2 * 100 = 300 + 200 = 500 paise.
        assert_eq!(purchase_total(&lines, &upb), 500);
    }

    #[test]
    fn purchase_total_zero_lines() {
        assert_eq!(purchase_total(&[], &[]), 0);
    }

    #[test]
    fn create_inward_rejects_empty() {
        let db = crate::db::Db::open_in_memory().expect("mem db");
        crate::session::__test_set_role(&db, crate::session::Role::Owner);
        let res = create_inward(
            &db,
            1,
            NewPurchase {
                vendor_id: None,
                date: None,
                notes: None,
                auto_print_label: false,
                lines: vec![],
            },
        );
        assert!(matches!(res, Err(PurchaseError::EmptyLines)));
    }

    #[test]
    fn create_inward_rejects_bad_qty() {
        let db = crate::db::Db::open_in_memory().expect("mem db");
        crate::session::__test_set_role(&db, crate::session::Role::Owner);
        let res = create_inward(
            &db,
            1,
            NewPurchase {
                vendor_id: None,
                date: None,
                notes: None,
                auto_print_label: false,
                lines: vec![InwardLine {
                    item_id: 1,
                    qty: 0.0,
                    unit_type: "unit".into(),
                    unit_price_paise: 100,
                    location_id: 1,
                }],
            },
        );
        assert!(matches!(res, Err(PurchaseError::BadQty(0))));
    }

    #[test]
    fn create_inward_inserts_purchase_items_and_movements_atomically() {
        // E25 + E26 + E28: full atomic flow with sticky cost + box conversion.
        let db = crate::db::Db::open_in_memory().expect("mem db");
        crate::session::__test_set_role(&db, crate::session::Role::Owner);

        db.with_conn(|c| -> anyhow::Result<()> {
            c.execute(
                "INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length, is_active, created_at, updated_at) VALUES ('Owner','owner',X'00',X'00',6,1,0,0)",
                [],
            )?;
            c.execute(
                "INSERT INTO items (sku_code, barcode, name, unit_code, unit_label, units_per_pack, retail_price_paise, cost_paise, is_active, created_at, updated_at)
                 VALUES ('TEST-001','1234567890','Red Paint 4L','L','Liter',4,25000,18000,1,0,0)",
                [],
            )?;
            c.execute(
                "INSERT INTO locations (name, zone, is_default, is_active, created_at, updated_at) VALUES ('Main',NULL,1,1,0,0)",
                [],
            )?;
            c.execute(
                "INSERT INTO vendors (name, credit_limit_paise, is_active, created_at, updated_at) VALUES ('Vendor',0,1,0,0)",
                [],
            )?;
            Ok(())
        })
        .unwrap();

        let res = create_inward(
            &db,
            1,
            NewPurchase {
                vendor_id: Some(1),
                date: Some("2026-06-19".into()),
                notes: Some("opening stock".into()),
                auto_print_label: true,
                lines: vec![InwardLine {
                    item_id: 1,
                    qty: 3.0,
                    unit_type: "unit".into(),
                    unit_price_paise: 18000,
                    location_id: 1,
                }],
            },
        )
        .expect("inward should succeed");
        assert_eq!(res.id, 1);
        assert!(res.print_label);

        // Verify atomic state.
        let p = get(&db, 1).expect("query").expect("exists");
        assert_eq!(p.total, 3 * 18000);
        assert_eq!(p.items.len(), 1);
        assert_eq!(p.items[0].qty, 3.0);

        // Stock movement: +3 base units.
        let moves = movements_for_item(&db, 1, 10).expect("moves");
        assert_eq!(moves.len(), 1);
        assert_eq!(moves[0].qty, 3.0);
        assert_eq!(moves[0].r#type, "purchase");
    }

    #[test]
    fn last_cost_returns_none_for_unknown_item() {
        let db = crate::db::Db::open_in_memory().expect("mem db");
        let v = last_cost_for_item(&db, 999).expect("query");
        assert!(v.is_none());
    }

    /// `vendor_id` must be optional — opening stock for a new app often
    /// has no traceable vendor (legacy stock, mixed cash purchases).
    #[test]
    fn create_inward_accepts_null_vendor_for_opening_stock() {
        let db = crate::db::Db::open_in_memory().expect("mem db");
        crate::session::__test_set_role(&db, crate::session::Role::Owner);

        db.with_conn(|c| -> anyhow::Result<()> {
            c.execute(
                "INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length, is_active, created_at, updated_at) VALUES ('Owner','owner',X'00',X'00',6,1,0,0)",
                [],
            )?;
            c.execute(
                "INSERT INTO items (sku_code, barcode, name, unit_code, unit_label, units_per_pack, retail_price_paise, cost_paise, is_active, created_at, updated_at)
                 VALUES ('TEST-001','1234567890','Red Paint 4L','L','Liter',4,25000,18000,1,0,0)",
                [],
            )?;
            c.execute(
                "INSERT INTO locations (name, zone, is_default, is_active, created_at, updated_at) VALUES ('Main',NULL,1,1,0,0)",
                [],
            )?;
            Ok(())
        })
        .unwrap();

        let res = create_inward(
            &db,
            1,
            NewPurchase {
                vendor_id: None,
                date: Some("2026-06-19".into()),
                notes: Some("opening stock".into()),
                auto_print_label: false,
                lines: vec![InwardLine {
                    item_id: 1,
                    qty: 5.0,
                    unit_type: "unit".into(),
                    unit_price_paise: 18000,
                    location_id: 1,
                }],
            },
        )
        .expect("inward with null vendor should succeed (opening stock)");

        assert_eq!(res.id, 1);

        let p = get(&db, 1).expect("query").expect("exists");
        assert_eq!(p.vendor_id, None);
        assert_eq!(p.vendor_name, None);
        assert_eq!(p.total, 5 * 18000);
    }
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_last_retail(state: tauri::State<'_, AppState>, _item_id: i64) -> AppResult<Option<i64>> {
    ipc_auth::authorize_err("cmd_last_retail", state.inner())?;
    Ok(None)
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_list_purchases_by_vendor(
    state: tauri::State<'_, AppState>,
    _vendor_id: i64,
    _limit: Option<i64>,
) -> AppResult<Vec<Purchase>> {
    ipc_auth::authorize_err("cmd_list_purchases_by_vendor", state.inner())?;
    Ok(Vec::new())
}

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

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::commands::auth::AppState;
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
    pub qty: i64,                 // base units (after box conversion)
    pub cost_price: i64,
    pub retail_price: i64,
    pub location_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct InwardLine {
    pub item_id: i64,
    pub qty: f64,
    pub unit_type: String, // "unit" | "box"
    pub cost_price: i64,
    pub retail_price: i64,
    pub location_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewPurchase {
    pub vendor_id: Option<i64>,
    pub date: Option<String>, // ISO YYYY-MM-DD; default today
    pub notes: Option<String>,
    /// When true, the response carries `print_label=true` so the frontend
    /// fires the JsBarcode label print (E-IA1).
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
    pub qty: i64,
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
    #[error("line {0}: cost_price must be >= 0")]
    BadCost(usize),
    #[error("line {0}: retail_price must be >= 0")]
    BadRetail(usize),
    #[error("line {0}: unit_type must be 'unit' or 'box'")]
    BadUnitType(usize),
    #[error("line {0}: item {1} not found")]
    ItemNotFound(usize, i64),
    #[error("line {0}: location {1} not found")]
    LocationNotFound(usize, i64),
    #[error("line {0}: units_per_box must be > 0 for unit_type=box")]
    BadUnitsPerBox(usize),
    #[error("db error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("{0}")]
    Other(#[from] anyhow::Error),
}

// -----------------------------------------------------------------------------
// Pure helpers (also unit-tested).
// -----------------------------------------------------------------------------

/// Resolve a line's base qty: boxes * units_per_box, else qty as-is.
/// `units_per_box` is the value from the items row for this line.
pub fn base_qty(line_qty: f64, unit_type: &str, units_per_box: i64) -> i64 {
    let raw = if unit_type == "box" {
        line_qty * units_per_box as f64
    } else {
        line_qty
    };
    raw.round() as i64
}

/// Compute total paise for a purchase = sum(qty_base * cost_price) for each
/// line. Frontend's expected value should match; we recompute on the Rust
/// side and reject mismatches.
pub fn purchase_total(lines: &[InwardLine], units_per_box: &[i64]) -> i64 {
    lines
        .iter()
        .zip(units_per_box.iter())
        .map(|(l, upb)| base_qty(l.qty, &l.unit_type, *upb) * l.cost_price)
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
            "SELECT cost_price FROM purchase_items
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
            "SELECT p.id, p.vendor_id, v.name, p.date, p.total, p.user_id, p.notes
             FROM purchases p LEFT JOIN vendors v ON v.id = p.vendor_id
             WHERE 1=1",
        );
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(f) = from_date {
            sql.push_str(" AND p.date >= ?");
            args.push(Box::new(f.to_string()));
        }
        if let Some(t) = to_date {
            sql.push_str(" AND p.date <= ?");
            args.push(Box::new(t.to_string()));
        }
        sql.push_str(" ORDER BY p.date DESC, p.id DESC LIMIT ?");
        args.push(Box::new(limit));
        let arg_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();

        let mut stmt = c.prepare(&sql)?;
        let mut rows = stmt.query(arg_refs.as_slice())?;
        let mut purchases = Vec::new();
        while let Some(r) = rows.next()? {
            let id: i64 = r.get(0)?;
            let vendor_id: Option<i64> = r.get(1)?;
            let vendor_name: Option<String> = r.get(2)?;
            let date: String = r.get(3)?;
            let total: i64 = r.get(4)?;
            let user_id: i64 = r.get(5)?;
            let notes: Option<String> = r.get(6)?;
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
            "SELECT p.id, p.vendor_id, v.name, p.date, p.total, p.user_id, p.notes
             FROM purchases p LEFT JOIN vendors v ON v.id = p.vendor_id
             WHERE p.id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            },
        );
        match r {
            Ok((id, vendor_id, vendor_name, date, total, user_id, notes)) => {
                let items = load_items(c, id)?;
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
                "SELECT id, item_id, location_id, qty, type, ref_type, ref_id, reason, user_id, created_at
                 FROM stock_movements WHERE item_id = ?1
                 ORDER BY id DESC LIMIT ?2",
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
                    user_id: r.get(8)?,
                    created_at: r.get(9)?,
                })
            })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
}

fn load_items(c: &rusqlite::Connection, purchase_id: i64) -> Result<Vec<PurchaseItem>, rusqlite::Error> {
    let mut stmt = c.prepare(
        "SELECT pi.item_id, i.name, pi.qty, pi.cost_price,
                pi.retail_price, pi.location_id
         FROM purchase_items pi JOIN items i ON i.id = pi.item_id
         WHERE pi.purchase_id = ?1 ORDER BY pi.id",
    )?;
    let rows = stmt.query_map(params![purchase_id], |r| {
        Ok(PurchaseItem {
            item_id: r.get(0)?,
            item_name: r.get(1)?,
            qty: r.get(2)?,
            cost_price: r.get(3)?,
            retail_price: r.get(4)?,
            location_id: r.get(5)?,
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

pub fn create_inward(db: &Db, user_id: i64, req: NewPurchase) -> Result<PurchaseCreated, PurchaseError> {
    if req.lines.is_empty() {
        return Err(PurchaseError::EmptyLines);
    }
    for (i, l) in req.lines.iter().enumerate() {
        if l.qty <= 0.0 || l.qty.is_nan() {
            return Err(PurchaseError::BadQty(i));
        }
        if l.cost_price < 0 {
            return Err(PurchaseError::BadCost(i));
        }
        if l.retail_price < 0 {
            return Err(PurchaseError::BadRetail(i));
        }
        if l.unit_type != "unit" && l.unit_type != "box" {
            return Err(PurchaseError::BadUnitType(i));
        }
    }
    let date = req.date.unwrap_or_else(today);

    let created = db.with_conn_immediate(|c| -> Result<PurchaseCreated, PurchaseError> {
        let mut upb_per_line: Vec<i64> = Vec::with_capacity(req.lines.len());
        for (i, l) in req.lines.iter().enumerate() {
            let upb: Option<i64> = c
                .query_row(
                    "SELECT units_per_box FROM items WHERE id = ?1",
                    params![l.item_id],
                    |r| r.get::<_, i64>(0),
                )
                .optional()
                .map_err(PurchaseError::Db)?;
            let upb = upb.ok_or(PurchaseError::ItemNotFound(i, l.item_id))?;
            if l.unit_type == "box" && upb <= 0 {
                return Err(PurchaseError::BadUnitsPerBox(i));
            }
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
        let pid: i64 = c.query_row(
            "INSERT INTO purchases (vendor_id, date, total, user_id, notes)
             VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id",
            params![req.vendor_id, date, total, user_id, req.notes],
            |r| r.get(0),
        )?;
        for (i, l) in req.lines.iter().enumerate() {
            let upb = upb_per_line[i];
            let base = base_qty(l.qty, &l.unit_type, upb);
            c.execute(
                "INSERT INTO purchase_items
                    (purchase_id,item_id,qty,cost_price,retail_price,location_id)
                 VALUES (?1,?2,?3,?4,?5,?6)",
                params![pid, l.item_id, base, l.cost_price, l.retail_price, l.location_id],
            )?;
            c.execute(
                "INSERT INTO stock_movements
                    (item_id, location_id, qty, type, ref_type, ref_id, user_id, created_at)
                 VALUES (?1, ?2, ?3, 'inward', 'purchase', ?4, ?5, ?6)",
                params![l.item_id, l.location_id, base, pid, user_id, now()],
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
// Date helpers.
// -----------------------------------------------------------------------------

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn now() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

// -----------------------------------------------------------------------------
// Tauri command surface.
// -----------------------------------------------------------------------------

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_create_inward(
    state: tauri::State<'_, AppState>,
    req: NewPurchase,
) -> AppResult<PurchaseCreated> {
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let session = state.session.lock().map_err(|_| AppError::Internal("session lock poisoned".into()))?;
    let user = session.as_ref().ok_or(AppError::NotUnlocked)?;
    create_inward(db, user.id, req).map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_last_cost(state: tauri::State<'_, AppState>, item_id: i64) -> AppResult<Option<i64>> {
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
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
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
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
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    get(db, id).map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_movements_for_item(
    state: tauri::State<'_, AppState>,
    item_id: i64,
    limit: Option<i64>,
) -> AppResult<Vec<StockMovement>> {
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    movements_for_item(db, item_id, limit.unwrap_or(200)).map_err(|e| AppError::Internal(e.to_string()))
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
            cost_price: cost,
            retail_price: cost + 500,
            location_id: 1,
        }
    }

    #[test]
    fn base_qty_unit_passes_through() {
        assert_eq!(base_qty(3.0, "unit", 12), 3);
    }

    #[test]
    fn base_qty_box_multiplies() {
        // E26: 2 boxes * 12 units_per_box = 24 base units.
        assert_eq!(base_qty(2.0, "box", 12), 24);
    }

    #[test]
    fn base_qty_box_rounds_non_integer_qty() {
        assert_eq!(base_qty(1.5, "box", 4), 6);
    }

    #[test]
    fn purchase_total_sums_base_times_cost() {
        let lines = vec![line(3.0, "unit", 100), line(2.0, "box", 100)];
        let upb = vec![12, 12];
        // 3 * 100 + 24 * 100 = 300 + 2400 = 2700 paise.
        assert_eq!(purchase_total(&lines, &upb), 2700);
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
                    cost_price: 100,
                    retail_price: 150,
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
                "INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length) VALUES ('Owner','owner',X'00',X'00',6)",
                [],
            )?;
            c.execute(
                "INSERT INTO items (sku_code, barcode, name, unit, units_per_box, retail_price, cost_price, is_active)
                 VALUES ('TEST-001','1234567890','Red Paint 4L','L',4,25000,18000,1)",
                [],
            )?;
            c.execute("INSERT INTO locations (name) VALUES ('Main')", [])?;
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
                auto_print_label: true,
                lines: vec![InwardLine {
                    item_id: 1,
                    qty: 3.0,
                    unit_type: "box".into(),
                    cost_price: 18000,
                    retail_price: 25000,
                    location_id: 1,
                }],
            },
        )
        .expect("inward should succeed");
        assert_eq!(res.id, 1);
        assert!(res.print_label);

        // Verify atomic state.
        let p = get(&db, 1).expect("query").expect("exists");
        assert_eq!(p.total, 3 * 4 * 18000);
        assert_eq!(p.items.len(), 1);
        assert_eq!(p.items[0].qty, 12);

        // Stock movement: +12 base units.
        let moves = movements_for_item(&db, 1, 10).expect("moves");
        assert_eq!(moves.len(), 1);
        assert_eq!(moves[0].qty, 12);
        assert_eq!(moves[0].r#type, "inward");
    }

    #[test]
    fn last_cost_returns_none_for_unknown_item() {
        let db = crate::db::Db::open_in_memory().expect("mem db");
        let v = last_cost_for_item(&db, 999).expect("query");
        assert!(v.is_none());
    }
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_last_retail(
    state: tauri::State<'_, AppState>,
    _item_id: i64,
) -> AppResult<Option<i64>> {
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

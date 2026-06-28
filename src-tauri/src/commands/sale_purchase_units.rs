use serde::{Deserialize, Serialize};

use crate::commands::auth::AppState;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::security::ipc_auth;

// ── Types ─────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SaleUnit {
    pub id: i64,
    pub code: String,
    pub label: String,
    pub quantity_precision: i64,
    pub is_active: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateSaleUnitData {
    pub code: String,
    pub label: String,
    pub quantity_precision: i64,
}

#[derive(Debug, Deserialize)]
pub struct UpdateSaleUnitData {
    pub label: Option<String>,
    pub quantity_precision: Option<i64>,
    pub is_active: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PurchaseUnit {
    pub id: i64,
    pub label: String,
    pub is_active: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdatePurchaseUnitData {
    pub label: Option<String>,
    pub is_active: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ItemPurchasePackaging {
    pub id: i64,
    pub item_id: i64,
    pub purchase_unit_id: i64,
    pub qty_per_purchase_unit: f64,
    pub purchase_unit_label: Option<String>,
}

// ── Helpers ───────────────────────────────────────────────────────

fn lock_db<'a>(
    state: &'a tauri::State<'_, AppState>,
) -> AppResult<std::sync::MutexGuard<'a, Option<db::Db>>> {
    state
        .db
        .lock()
        .map_err(|e| AppError::Internal(e.to_string()))
}

// ── Sale Units ────────────────────────────────────────────────────

#[tauri::command(rename_all = "snake_case")]
pub fn list_sale_units(
    state: tauri::State<'_, AppState>,
    include_inactive: bool,
) -> AppResult<Vec<SaleUnit>> {
    ipc_auth::authorize_err("list_sale_units", state.inner())?;
    let db_guard = lock_db(&state)?;
    let db = db_guard.as_ref().ok_or(AppError::NotUnlocked)?;
    db.with_conn(|conn| {
        let sql = if include_inactive {
            "SELECT id, code, label, quantity_precision, is_active, created_at, updated_at FROM sale_units ORDER BY code"
        } else {
            "SELECT id, code, label, quantity_precision, is_active, created_at, updated_at FROM sale_units WHERE is_active = 1 ORDER BY code"
        };
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map([], |r| {
            Ok(SaleUnit {
                id: r.get(0)?,
                code: r.get(1)?,
                label: r.get(2)?,
                quantity_precision: r.get(3)?,
                is_active: r.get::<_, i64>(4)? != 0,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn create_sale_unit(
    state: tauri::State<'_, AppState>,
    data: CreateSaleUnitData,
) -> AppResult<i64> {
    ipc_auth::authorize_err("create_sale_unit", state.inner())?;
    let code = data.code.trim().to_lowercase();
    let label = data.label.trim().to_string();
    if code.is_empty() || label.is_empty() {
        return Err(AppError::Validation(
            "Sale unit code and label are required".into(),
        ));
    }
    if !matches!(data.quantity_precision, 0 | 3) {
        return Err(AppError::Validation(
            "quantity_precision must be 0 (integer) or 3 (decimal)".into(),
        ));
    }
    let db_guard = lock_db(&state)?;
    let db = db_guard.as_ref().ok_or(AppError::NotUnlocked)?;
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO sale_units (code, label, quantity_precision) VALUES (?1, ?2, ?3)",
            rusqlite::params![code, label, data.quantity_precision],
        )?;
        Ok(conn.last_insert_rowid())
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn update_sale_unit(
    state: tauri::State<'_, AppState>,
    id: i64,
    data: UpdateSaleUnitData,
) -> AppResult<()> {
    ipc_auth::authorize_err("update_sale_unit", state.inner())?;
    let db_guard = lock_db(&state)?;
    let db = db_guard.as_ref().ok_or(AppError::NotUnlocked)?;
    db.with_conn(|conn| {
        let exists: bool = conn.query_row(
            "SELECT COUNT(*) FROM sale_units WHERE id = ?1",
            rusqlite::params![id],
            |r| Ok(r.get::<_, i64>(0)? > 0),
        )?;
        if !exists {
            return Err(AppError::NotFound(format!("sale_unit {id}")));
        }
        let new_label = data.label.map(|l| l.trim().to_string()).filter(|l| !l.is_empty());
        let new_precision = data.quantity_precision;
        let new_active = data.is_active.map(|a| a as i64);
        if let Some(p) = new_precision {
            if !matches!(p, 0 | 3) {
                return Err(AppError::Validation(
                    "quantity_precision must be 0 (integer) or 3 (decimal)".into(),
                ));
            }
        }
        conn.execute(
            "UPDATE sale_units SET \
                label = COALESCE(?1, label), \
                quantity_precision = COALESCE(?2, quantity_precision), \
                is_active = COALESCE(?3, is_active), \
                updated_at = datetime('now') \
            WHERE id = ?4",
            rusqlite::params![new_label, new_precision, new_active, id],
        )?;
        Ok(())
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn deactivate_sale_unit(state: tauri::State<'_, AppState>, id: i64) -> AppResult<()> {
    ipc_auth::authorize_err("deactivate_sale_unit", state.inner())?;
    let db_guard = lock_db(&state)?;
    let db = db_guard.as_ref().ok_or(AppError::NotUnlocked)?;
    db.with_conn(|conn| {
        let ref_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM items WHERE sell_unit_id = ?1",
            rusqlite::params![id],
            |r| r.get(0),
        )?;
        if ref_count > 0 {
            return Err(AppError::Conflict(format!(
                "Cannot deactivate: {ref_count} item(s) use this sale unit"
            )));
        }
        let n = conn.execute(
            "UPDATE sale_units SET is_active = 0, updated_at = datetime('now') WHERE id = ?1",
            rusqlite::params![id],
        )?;
        if n == 0 {
            return Err(AppError::NotFound(format!("sale_unit {id}")));
        }
        Ok(())
    })
}

// ── Purchase Units ────────────────────────────────────────────────

#[tauri::command(rename_all = "snake_case")]
pub fn list_purchase_units(
    state: tauri::State<'_, AppState>,
    include_inactive: bool,
) -> AppResult<Vec<PurchaseUnit>> {
    ipc_auth::authorize_err("list_purchase_units", state.inner())?;
    let db_guard = lock_db(&state)?;
    let db = db_guard.as_ref().ok_or(AppError::NotUnlocked)?;
    db.with_conn(|conn| {
        let sql = if include_inactive {
            "SELECT id, label, is_active, created_at, updated_at FROM purchase_units ORDER BY label"
        } else {
            "SELECT id, label, is_active, created_at, updated_at FROM purchase_units WHERE is_active = 1 ORDER BY label"
        };
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map([], |r| {
            Ok(PurchaseUnit {
                id: r.get(0)?,
                label: r.get(1)?,
                is_active: r.get::<_, i64>(2)? != 0,
                created_at: r.get(3)?,
                updated_at: r.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn create_purchase_unit(
    state: tauri::State<'_, AppState>,
    label: String,
) -> AppResult<i64> {
    ipc_auth::authorize_err("create_purchase_unit", state.inner())?;
    let label = label.trim().to_string();
    if label.is_empty() {
        return Err(AppError::Validation(
            "Purchase unit label is required".into(),
        ));
    }
    let db_guard = lock_db(&state)?;
    let db = db_guard.as_ref().ok_or(AppError::NotUnlocked)?;
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO purchase_units (label) VALUES (?1)",
            rusqlite::params![label],
        )?;
        Ok(conn.last_insert_rowid())
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn update_purchase_unit(
    state: tauri::State<'_, AppState>,
    id: i64,
    data: UpdatePurchaseUnitData,
) -> AppResult<()> {
    ipc_auth::authorize_err("update_purchase_unit", state.inner())?;
    let db_guard = lock_db(&state)?;
    let db = db_guard.as_ref().ok_or(AppError::NotUnlocked)?;
    db.with_conn(|conn| {
        let exists: bool = conn.query_row(
            "SELECT COUNT(*) FROM purchase_units WHERE id = ?1",
            rusqlite::params![id],
            |r| Ok(r.get::<_, i64>(0)? > 0),
        )?;
        if !exists {
            return Err(AppError::NotFound(format!("purchase_unit {id}")));
        }
        let new_label = data.label.map(|l| l.trim().to_string()).filter(|l| !l.is_empty());
        let new_active = data.is_active.map(|a| a as i64);
        conn.execute(
            "UPDATE purchase_units SET \
                label = COALESCE(?1, label), \
                is_active = COALESCE(?2, is_active), \
                updated_at = datetime('now') \
            WHERE id = ?3",
            rusqlite::params![new_label, new_active, id],
        )?;
        Ok(())
    })
}

// ── Item Purchase Packaging ───────────────────────────────────────

#[tauri::command(rename_all = "snake_case")]
pub fn get_item_packaging(
    state: tauri::State<'_, AppState>,
    item_id: i64,
) -> AppResult<Vec<ItemPurchasePackaging>> {
    ipc_auth::authorize_err("get_item_packaging", state.inner())?;
    let db_guard = lock_db(&state)?;
    let db = db_guard.as_ref().ok_or(AppError::NotUnlocked)?;
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT ipp.id, ipp.item_id, ipp.purchase_unit_id, ipp.qty_per_purchase_unit, \
                    pu.label \
             FROM item_purchase_packaging ipp \
             JOIN purchase_units pu ON pu.id = ipp.purchase_unit_id \
             WHERE ipp.item_id = ?1 \
             ORDER BY pu.label",
        )?;
        let rows = stmt.query_map(rusqlite::params![item_id], |r| {
            Ok(ItemPurchasePackaging {
                id: r.get(0)?,
                item_id: r.get(1)?,
                purchase_unit_id: r.get(2)?,
                qty_per_purchase_unit: r.get(3)?,
                purchase_unit_label: r.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn set_item_packaging(
    state: tauri::State<'_, AppState>,
    item_id: i64,
    purchase_unit_id: i64,
    qty: f64,
) -> AppResult<()> {
    ipc_auth::authorize_err("set_item_packaging", state.inner())?;
    if qty <= 0.0 {
        return Err(AppError::Validation(
            "qty_per_purchase_unit must be > 0".into(),
        ));
    }
    let db_guard = lock_db(&state)?;
    let db = db_guard.as_ref().ok_or(AppError::NotUnlocked)?;
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO item_purchase_packaging (item_id, purchase_unit_id, qty_per_purchase_unit, updated_at) \
             VALUES (?1, ?2, ?3, datetime('now')) \
             ON CONFLICT(item_id, purchase_unit_id) DO UPDATE SET \
                qty_per_purchase_unit = excluded.qty_per_purchase_unit, \
                updated_at = datetime('now')",
            rusqlite::params![item_id, purchase_unit_id, qty],
        )?;
        Ok(())
    })
}

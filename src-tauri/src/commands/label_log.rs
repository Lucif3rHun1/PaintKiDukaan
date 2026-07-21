use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::auth::AppState;
use crate::error::{AppError, AppResult};
use crate::security::ipc_auth;
use crate::session::current_user;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelPrintRecord {
    pub id: i64,
    pub item_id: i64,
    pub item_name: String,
    pub barcode: String,
    pub qty: i64,
    pub format: String,
    pub line1: Option<String>,
    pub line2: Option<String>,
    pub created_at: String,
    pub user_name: Option<String>,
    pub tspl_config: Option<String>,
    pub printer: Option<String>,
    pub label_size: Option<String>,
    pub labels_per_row: Option<i64>,
}

fn row_to_label_print_record(r: &rusqlite::Row) -> rusqlite::Result<LabelPrintRecord> {
    Ok(LabelPrintRecord {
        id: r.get(0)?,
        item_id: r.get(1)?,
        item_name: r.get(2)?,
        barcode: r.get(3)?,
        qty: r.get(4)?,
        format: r.get(5)?,
        line1: r.get(6)?,
        line2: r.get(7)?,
        created_at: r.get::<_, i64>(8)?.to_string(),
        user_name: r.get(9)?,
        tspl_config: r.get(10)?,
        printer: r.get(11)?,
        label_size: r.get(12)?,
        labels_per_row: r.get(13)?,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn record_label_print(
    state: State<'_, AppState>,
    item_id: i64,
    barcode: String,
    qty: i64,
    format: String,
    line1: Option<String>,
    line2: Option<String>,
    tspl_config: Option<String>,
    printer: Option<String>,
    label_size: Option<String>,
    labels_per_row: Option<i64>,
) -> AppResult<i64> {
    ipc_auth::authorize_err("record_label_print", state.inner())?;
    if item_id <= 0 {
        return Err(AppError::Validation("item_id is required".into()));
    }
    if barcode.trim().is_empty() {
        return Err(AppError::Validation("barcode is required".into()));
    }
    if qty <= 0 {
        return Err(AppError::Validation("qty must be > 0".into()));
    }
    if format.trim().is_empty() {
        return Err(AppError::Validation("format is required".into()));
    }

    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let user = current_user(state.inner())?;
    db.with_tx(|tx| {
        let exists: i64 = tx.query_row(
            "SELECT COUNT(*) FROM items WHERE id = ?1",
            params![item_id],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(AppError::NotFound(format!("item {item_id}")));
        }
        tx.execute(
            "INSERT INTO label_print_log
                (item_id, barcode, qty, format, line1, line2, user_id, created_at,
                 tspl_config, printer, label_size, labels_per_row)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, (unixepoch('now') * 1000), ?8, ?9, ?10, ?11)",
            params![
                item_id,
                barcode.trim(),
                qty,
                format.trim(),
                line1.as_deref().map(str::trim).filter(|s| !s.is_empty()),
                line2.as_deref().map(str::trim).filter(|s| !s.is_empty()),
                user.id,
                tspl_config
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty()),
                printer.as_deref().map(str::trim).filter(|s| !s.is_empty()),
                label_size
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty()),
                labels_per_row,
            ],
        )?;
        Ok(tx.last_insert_rowid())
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn list_label_prints(
    state: State<'_, AppState>,
    item_id: Option<i64>,
    limit: Option<i64>,
) -> AppResult<Vec<LabelPrintRecord>> {
    ipc_auth::authorize_err("list_label_prints", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let _ = current_user(state.inner())?;
    let limit = limit.unwrap_or(50).clamp(1, 200);
    db.with_raw(|conn| {
        let base = "SELECT l.id, l.item_id, COALESCE(b.name || ' · ' || i.name, i.name), l.barcode, l.qty,
                    l.format, l.line1, l.line2, l.created_at, u.name,
                    l.tspl_config, l.printer, l.label_size, l.labels_per_row
                    FROM label_print_log l
                    LEFT JOIN items i ON i.id = l.item_id
                    LEFT JOIN brands b ON b.id = i.brand_id
                    LEFT JOIN users u ON u.id = l.user_id";
        let mut out = Vec::new();
        if let Some(item_id) = item_id {
            let mut stmt = conn.prepare(&format!(
                "{base} WHERE l.item_id = ?1 ORDER BY l.created_at DESC, l.id DESC LIMIT ?2"
            ))?;
            let rows = stmt.query_map(params![item_id, limit], row_to_label_print_record)?;
            for row in rows {
                out.push(row?);
            }
        } else {
            let mut stmt = conn.prepare(&format!(
                "{base} ORDER BY l.created_at DESC, l.id DESC LIMIT ?1"
            ))?;
            let rows = stmt.query_map(params![limit], row_to_label_print_record)?;
            for row in rows {
                out.push(row?);
            }
        }
        Ok(out)
    })
}

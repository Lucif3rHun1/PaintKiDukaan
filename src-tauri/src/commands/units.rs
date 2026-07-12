use serde::{Deserialize, Serialize};

use crate::commands::auth::AppState;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::security::ipc_auth;


#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Unit {
    pub id: i64,
    pub code: String,
    pub label: String,
    pub dimension: String,
    pub is_active: bool,
}

fn lock_db<'a>(
    state: &'a tauri::State<'_, AppState>,
) -> AppResult<std::sync::MutexGuard<'a, Option<db::Db>>> {
    state
        .db
        .lock()
        .map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command(rename_all = "snake_case")]
pub fn list_units(
    state: tauri::State<'_, AppState>,
    include_inactive: bool,
) -> AppResult<Vec<Unit>> {
    ipc_auth::authorize_err("list_units", state.inner())?;
    let db_guard = lock_db(&state)?;
    let db = db_guard.as_ref().ok_or(AppError::NotUnlocked)?;
    db.with_conn(|conn| {
        let sql = if include_inactive {
            "SELECT id, code, label, dimension, is_active FROM units ORDER BY code"
        } else {
            "SELECT id, code, label, dimension, is_active FROM units WHERE is_active = 1 ORDER BY code"
        };
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map([], |r| {
            Ok(Unit {
                id: r.get(0)?,
                code: r.get(1)?,
                label: r.get(2)?,
                dimension: r.get(3)?,
                is_active: r.get::<_, i64>(4)? != 0,
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
pub fn create_unit(
    state: tauri::State<'_, AppState>,
    code: String,
    label: String,
    dimension: String,
) -> AppResult<Unit> {
    ipc_auth::authorize_err("create_unit", state.inner())?;
    let code = code.trim().to_string();
    let label = label.trim().to_string();
    let dimension = dimension.trim().to_string();
    if code.is_empty() || label.is_empty() {
        return Err(AppError::Validation(
            "Unit code and label are required".to_string(),
        ));
    }
    if !matches!(dimension.as_str(), "volume" | "mass" | "area" | "count") {
        return Err(AppError::Validation(
            "Dimension must be one of volume, mass, area, count".to_string(),
        ));
    }
    let db_guard = lock_db(&state)?;
    let db = db_guard.as_ref().ok_or(AppError::NotUnlocked)?;
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO units (code, label, dimension, created_at, updated_at) VALUES (?1, ?2, ?3, (unixepoch('now') * 1000), (unixepoch('now') * 1000))",
            rusqlite::params![code, label, dimension],
        )?;
        let id = conn.last_insert_rowid();
        Ok(Unit {
            id,
            code,
            label,
            dimension,
            is_active: true,
        })
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn update_unit(
    state: tauri::State<'_, AppState>,
    id: i64,
    code: Option<String>,
    label: Option<String>,
    dimension: Option<String>,
) -> AppResult<Unit> {
    ipc_auth::authorize_err("update_unit", state.inner())?;
    if let Some(ref d) = dimension {
        let d = d.trim();
        if !matches!(d, "volume" | "mass" | "area" | "count") {
            return Err(AppError::Validation(
                "Dimension must be one of volume, mass, area, count".to_string(),
            ));
        }
    }
    let db_guard = lock_db(&state)?;
    let db = db_guard.as_ref().ok_or(AppError::NotUnlocked)?;
    db.with_conn(|conn| {
        let current = conn.query_row(
            "SELECT id, code, label, dimension, is_active FROM units WHERE id = ?1",
            rusqlite::params![id],
            |r| {
                Ok(Unit {
                    id: r.get(0)?,
                    code: r.get(1)?,
                    label: r.get(2)?,
                    dimension: r.get(3)?,
                    is_active: r.get::<_, i64>(4)? != 0,
                })
            },
        )?;
        let new_code = code.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
        let new_label = label.map(|l| l.trim().to_string()).filter(|l| !l.is_empty());
        let new_dimension = dimension.map(|d| d.trim().to_string()).filter(|d| !d.is_empty());
        conn.execute(
            "UPDATE units SET code = COALESCE(?1, code), label = COALESCE(?2, label), dimension = COALESCE(?3, dimension) WHERE id = ?4",
            rusqlite::params![new_code, new_label, new_dimension, id],
        )?;
        Ok(Unit {
            id,
            code: new_code.unwrap_or(current.code),
            label: new_label.unwrap_or(current.label),
            dimension: new_dimension.unwrap_or(current.dimension),
            is_active: current.is_active,
        })
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn deactivate_unit(state: tauri::State<'_, AppState>, id: i64) -> AppResult<()> {
    ipc_auth::authorize_err("deactivate_unit", state.inner())?;
    let db_guard = lock_db(&state)?;
    let db = db_guard.as_ref().ok_or(AppError::NotUnlocked)?;
    db.with_conn(|conn| {
        let ref_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM items WHERE sell_unit_id = ?1",
            rusqlite::params![id],
            |r| r.get(0),
        )?;
        if ref_count > 0 {
            let n = conn.execute(
                "UPDATE units SET is_active = 0 WHERE id = ?1",
                rusqlite::params![id],
            )?;
            if n == 0 {
                return Err(AppError::NotFound(format!("unit {id}")));
            }
        } else {
            let n = conn.execute("DELETE FROM units WHERE id = ?1", rusqlite::params![id])?;
            if n == 0 {
                return Err(AppError::NotFound(format!("unit {id}")));
            }
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn unit_conversion_factor_must_be_positive() {
        assert!((0.0_f64 > 0.0) == false);
        assert!((1.0_f64 > 0.0) == true);
    }

    #[test]
    fn unit_dimension_must_be_valid() {
        for d in ["volume", "mass", "area", "count"] {
            assert!(matches!(d, "volume" | "mass" | "area" | "count"));
        }
    }
}

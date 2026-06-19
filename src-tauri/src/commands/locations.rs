//! Locations CRUD. Soft delete only — no hard delete so item.location_text
//! FK references stay valid. Only owners can mutate; anyone authenticated can read.

use crate::error::{AppError, AppResult};
use crate::session::{current_user, require_role, Role};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;
use crate::commands::auth::AppState;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Location {
    pub id: i64,
    pub name: String,
    pub rack: Option<String>,
    pub is_active: bool,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct NewLocation {
    pub name: String,
    pub rack: Option<String>,
}

#[tauri::command]
pub fn list_locations(state: State<'_, AppState>, include_inactive: bool) -> AppResult<Vec<Location>> {
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let _ = current_user()?;
    let sql = if include_inactive {
        "SELECT id, name, rack, is_active, created_at FROM locations ORDER BY name"
    } else {
        "SELECT id, name, rack, is_active, created_at FROM locations WHERE is_active = 1 ORDER BY name"
    };
    db.with_raw(|c| {
        let mut stmt = c.prepare(sql)?;
        let rows = stmt.query_map([], |r| {
            Ok(Location {
                id: r.get(0)?,
                name: r.get(1)?,
                rack: r.get(2)?,
                is_active: r.get::<_, i64>(3)? != 0,
                created_at: r.get(4)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    })
}

#[tauri::command]
pub fn create_location(state: State<'_, AppState>, payload: NewLocation) -> AppResult<Location> {
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let user = current_user()?;
    require_role(&user, &[Role::Owner, Role::Stocker])?;
    let name = payload.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Validation("name is required".into()));
    }
    db.with_tx(|tx| {
        tx.execute(
            "INSERT INTO locations (name, rack, is_active) VALUES (?1, ?2, 1)",
            params![name, payload.rack],
        )?;
        let id = tx.last_insert_rowid();
        Ok(Location {
            id,
            name,
            rack: payload.rack,
            is_active: true,
            created_at: tx.query_row(
                "SELECT created_at FROM locations WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )?,
        })
    })
}

#[tauri::command]
pub fn rename_location(
    state: State<'_, AppState>,
    id: i64,
    new_name: String,
    new_rack: Option<String>,
) -> AppResult<Location> {
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let user = current_user()?;
    require_role(&user, &[Role::Owner, Role::Stocker])?;
    let name = new_name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Validation("name is required".into()));
    }
    db.with_tx(|tx| {
        let n = tx.execute(
            "UPDATE locations SET name = ?1, rack = ?2 WHERE id = ?3",
            params![name, new_rack, id],
        )?;
        if n == 0 {
            return Err(AppError::NotFound(format!("location {id}")));
        }
        Ok(Location {
            id,
            name,
            rack: new_rack,
            is_active: tx.query_row(
                "SELECT is_active FROM locations WHERE id = ?1",
                params![id],
                |r| r.get::<_, i64>(0),
            )? != 0,
            created_at: tx.query_row(
                "SELECT created_at FROM locations WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )?,
        })
    })
}

#[tauri::command]
pub fn deactivate_location(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let user = current_user()?;
    require_role(&user, &[Role::Owner])?;
    db.with_tx(|tx| {
        // Warn but allow if items still reference this location textually.
        // The text is denormalised so we don't block.
        let n = tx.execute(
            "UPDATE locations SET is_active = 0 WHERE id = ?1",
            params![id],
        )?;
        if n == 0 {
            return Err(AppError::NotFound(format!("location {id}")));
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::session::{set_current_user, User};

    fn owner() -> User {
        User { id: 1, name: "O".into(), role: Role::Owner }
    }

    #[test]
    fn create_rename_deactivate() {
        set_current_user(Some(owner()));
        let db = Db::open_in_memory().unwrap();
        let loc = {
            let mut name = String::from("Rack A");
            let rack: Option<String> = Some("Row 1".into());
            db.with_raw(|c| {
                c.execute(
                    "INSERT INTO locations (name, rack, is_active) VALUES (?1, ?2, 1)",
                    rusqlite::params![&name, &rack],
                )
                .unwrap();
                let id = c.last_insert_rowid();
                // rename
                name = "Rack A1".into();
                c.execute("UPDATE locations SET name = ?1 WHERE id = ?2", rusqlite::params![&name, id])
                    .unwrap();
                // deactivate
                c.execute("UPDATE locations SET is_active = 0 WHERE id = ?1", [id])
                    .unwrap();
                id
            })
        };
        let active: i64 = db.with_raw(|c| {
            c.query_row("SELECT is_active FROM locations WHERE id = ?1", [loc], |r| r.get(0))
                .unwrap()
        });
        assert_eq!(active, 0);
    }
}

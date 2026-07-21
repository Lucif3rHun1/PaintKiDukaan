use crate::commands::auth::AppState;
use crate::error::{AppError, AppResult};
use crate::security::ipc_auth;
use crate::session::{current_user, require_role, Role};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SubLocation {
    pub id: i64,
    pub location_id: i64,
    pub name: String,
    pub position: Option<String>,
    pub is_active: bool,
    pub created_at: String,
}

#[tauri::command(rename_all = "snake_case")]
pub fn list_sub_locations(
    state: State<'_, AppState>,
    location_id: Option<i64>,
    include_inactive: bool,
) -> AppResult<Vec<SubLocation>> {
    ipc_auth::authorize_err("list_sub_locations", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let _ = current_user(state.inner())?;
    db.with_raw(|c| {
        let (sql, query_params): (&str, Vec<Box<dyn rusqlite::types::ToSql>>) = match (location_id, include_inactive) {
            (Some(lid), true) => (
                "SELECT id, location_id, name, position, is_active, created_at FROM sub_locations WHERE location_id = ?1 ORDER BY position, name",
                vec![Box::new(lid)],
            ),
            (Some(lid), false) => (
                "SELECT id, location_id, name, position, is_active, created_at FROM sub_locations WHERE location_id = ?1 AND is_active = 1 ORDER BY position, name",
                vec![Box::new(lid)],
            ),
            (None, true) => (
                "SELECT id, location_id, name, position, is_active, created_at FROM sub_locations ORDER BY location_id, position, name",
                vec![],
            ),
            (None, false) => (
                "SELECT id, location_id, name, position, is_active, created_at FROM sub_locations WHERE is_active = 1 ORDER BY location_id, position, name",
                vec![],
            ),
        };
        let mut stmt = c.prepare(sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(query_params.iter()), |r| {
            Ok(SubLocation {
                id: r.get(0)?,
                location_id: r.get(1)?,
                name: r.get(2)?,
                position: r.get(3)?,
                is_active: r.get::<_, i64>(4)? != 0,
                created_at: r.get::<_, i64>(5)?.to_string(),
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn create_sub_location(
    state: State<'_, AppState>,
    location_id: i64,
    name: String,
    position: Option<String>,
) -> AppResult<SubLocation> {
    ipc_auth::authorize_err("create_sub_location", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let user = current_user(state.inner())?;
    require_role(&user, &[Role::Owner, Role::Stocker])?;
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Validation("name is required".into()));
    }
    let pos: Option<String> = position;
    db.with_tx(|tx| {
        let exists: bool = tx.query_row(
            "SELECT COUNT(*) FROM locations WHERE id = ?1",
            params![location_id],
            |r| r.get::<_, i64>(0),
        )? > 0;
        if !exists {
            return Err(AppError::NotFound(format!("location {location_id}")));
        }

        let existing: Option<(i64, bool)> = tx
            .query_row(
                "SELECT id, is_active FROM sub_locations WHERE location_id = ?1 AND name = ?2",
                params![location_id, name],
                |r| Ok((r.get(0)?, r.get::<_, i64>(1)? != 0)),
            )
            .ok();

        if let Some((id, is_active)) = existing {
            if is_active {
                return Err(AppError::Conflict(format!(
                    "sub-location '{name}' already exists in this location"
                )));
            }
            tx.execute(
                "UPDATE sub_locations SET is_active = 1, position = ?1, updated_at = (unixepoch('now') * 1000) WHERE id = ?2",
                params![pos, id],
            )?;
            return Ok(SubLocation {
                id,
                location_id,
                name,
                position: pos.clone(),
                is_active: true,
                created_at: tx.query_row(
                    "SELECT created_at FROM sub_locations WHERE id = ?1",
                    params![id],
                    |r| r.get::<_, i64>(0).map(|v| v.to_string()),
                )?,
            });
        }

        tx.execute(
            "INSERT INTO sub_locations (location_id, name, position, created_at, updated_at) VALUES (?1, ?2, ?3, (unixepoch('now') * 1000), (unixepoch('now') * 1000))",
            params![location_id, name, pos],
        )?;
        let id = tx.last_insert_rowid();
        Ok(SubLocation {
            id,
            location_id,
            name,
            position: pos.clone(),
            is_active: true,
            created_at: tx.query_row(
                "SELECT created_at FROM sub_locations WHERE id = ?1",
                params![id],
                |r| r.get::<_, i64>(0).map(|v| v.to_string()),
            )?,
        })
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn update_sub_location(
    state: State<'_, AppState>,
    id: i64,
    name: Option<String>,
    position: Option<String>,
) -> AppResult<SubLocation> {
    ipc_auth::authorize_err("update_sub_location", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let user = current_user(state.inner())?;
    require_role(&user, &[Role::Owner, Role::Stocker])?;
    db.with_tx(|tx| {
        // Fetch current row.
        let current = tx.query_row(
            "SELECT id, location_id, name, position, is_active, created_at FROM sub_locations WHERE id = ?1",
            params![id],
            |r| {
                Ok(SubLocation {
                    id: r.get(0)?,
                    location_id: r.get(1)?,
                    name: r.get(2)?,
                    position: r.get(3)?,
                    is_active: r.get::<_, i64>(4)? != 0,
                    created_at: r.get::<_, i64>(5)?.to_string(),
                })
            },
        )?;
        let new_name = name
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty());
        let new_pos = position.or(current.position.clone());
        if let Some(ref n) = new_name {
            if n.is_empty() {
                return Err(AppError::Validation("name cannot be empty".into()));
            }
        }
        let n = tx.execute(
            "UPDATE sub_locations SET name = COALESCE(?1, name), position = ?2, updated_at = (unixepoch('now') * 1000) WHERE id = ?3",
            params![new_name, new_pos, id],
        )?;
        if n == 0 {
            return Err(AppError::NotFound(format!("sub_location {id}")));
        }
        Ok(SubLocation {
            id,
            location_id: current.location_id,
            name: new_name.unwrap_or(current.name),
            position: new_pos,
            is_active: current.is_active,
            created_at: current.created_at,
        })
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn deactivate_sub_location(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    ipc_auth::authorize_err("deactivate_sub_location", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let user = current_user(state.inner())?;
    require_role(&user, &[Role::Owner])?;
    db.with_tx(|tx| {
        // Check for items referencing this sub-location before deactivating.
        let ref_count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM items WHERE sub_location_id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        if ref_count > 0 {
            return Err(AppError::Validation(format!(
                "cannot deactivate: {ref_count} item(s) reference this sub-location"
            )));
        }
        let n = tx.execute(
            "UPDATE sub_locations SET is_active = 0, updated_at = (unixepoch('now') * 1000) WHERE id = ?1",
            params![id],
        )?;
        if n == 0 {
            return Err(AppError::NotFound(format!("sub_location {id}")));
        }
        Ok(())
    })
}

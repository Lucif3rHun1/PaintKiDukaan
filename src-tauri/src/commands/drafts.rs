use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::auth::AppState;
use crate::error::{AppError, AppResult};
use crate::security::ipc_auth;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Draft {
    pub id: i64,
    pub user_id: i64,
    pub form_type: String,
    pub data_json: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SaveDraftPayload {
    pub form_type: String,
    pub data_json: String,
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_save_draft(state: State<'_, AppState>, payload: SaveDraftPayload) -> AppResult<Draft> {
    ipc_auth::authorize_err("cmd_save_draft", state.inner())?;
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

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let draft = db.with_tx(|conn| -> AppResult<Draft> {
        conn.execute(
            "INSERT INTO drafts (user_id, form_type, data_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(user_id, form_type) DO UPDATE SET
               data_json = excluded.data_json,
               updated_at = excluded.updated_at",
            rusqlite::params![user.id, payload.form_type, payload.data_json, now],
        )?;

        let mut stmt = conn.prepare(
            "SELECT id, user_id, form_type, data_json, created_at, updated_at
             FROM drafts WHERE user_id = ?1 AND form_type = ?2",
        )?;
        let draft = stmt.query_row(rusqlite::params![user.id, payload.form_type], |row| {
            Ok(Draft {
                id: row.get(0)?,
                user_id: row.get(1)?,
                form_type: row.get(2)?,
                data_json: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?;

        Ok(draft)
    })?;

    Ok(draft)
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_get_draft(state: State<'_, AppState>, form_type: String) -> AppResult<Option<Draft>> {
    ipc_auth::authorize_err("cmd_get_draft", state.inner())?;
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

    let draft = db.with_conn(|conn| -> AppResult<Option<Draft>> {
        let mut stmt = conn.prepare(
            "SELECT id, user_id, form_type, data_json, created_at, updated_at
             FROM drafts WHERE user_id = ?1 AND form_type = ?2",
        )?;
        let result = stmt.query_row(rusqlite::params![user.id, form_type], |row| {
            Ok(Draft {
                id: row.get(0)?,
                user_id: row.get(1)?,
                form_type: row.get(2)?,
                data_json: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        });
        match result {
            Ok(draft) => Ok(Some(draft)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    })?;

    Ok(draft)
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_delete_draft(state: State<'_, AppState>, form_type: String) -> AppResult<()> {
    ipc_auth::authorize_err("cmd_delete_draft", state.inner())?;
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

    db.with_conn(|conn| -> AppResult<()> {
        conn.execute(
            "DELETE FROM drafts WHERE user_id = ?1 AND form_type = ?2",
            rusqlite::params![user.id, form_type],
        )?;
        Ok(())
    })?;

    Ok(())
}

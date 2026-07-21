use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::auth::AppState;
use crate::db::list::{paged_query, sanitize_dir, sanitize_sort, ListPage, ListQuery};
use crate::error::{AppError, AppResult};
use crate::security::ipc_auth;
use crate::session::{current_user, require_auth, require_role, Role};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Category {
    pub id: i64,
    pub name: String,
    pub is_active: bool,
}

#[tauri::command(rename_all = "snake_case")]
pub fn list_categories(state: State<'_, AppState>) -> AppResult<Vec<Category>> {
    let _ = require_auth("list_categories", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    db.with_raw(|c| {
        let mut stmt = c.prepare(
            "SELECT id, name, is_active FROM categories WHERE is_active = 1 ORDER BY name COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Category {
                id: r.get(0)?,
                name: r.get(1)?,
                is_active: r.get::<_, i64>(2)? != 0,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn create_category(state: State<'_, AppState>, name: String) -> AppResult<Category> {
    ipc_auth::authorize("create_category", state.inner())?;
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Validation("category name is required".into()));
    }
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let user = current_user(state.inner())?;
    require_role(&user, &[Role::Owner])?;
    db.with_tx(|tx| {
        let collision: i64 = tx.query_row(
            "SELECT COUNT(*) FROM categories WHERE name = ?1 COLLATE NOCASE",
            params![name],
            |r| r.get(0),
        )?;
        if collision > 0 {
            return Err(AppError::Conflict(format!(
                "category '{name}' already exists"
            )));
        }
        tx.execute(
            "INSERT INTO categories (name, is_active, created_at, updated_at) VALUES (?1, 1, (unixepoch('now') * 1000), (unixepoch('now') * 1000))",
            params![name],
        )?;
        let id = tx.last_insert_rowid() as i64;
        Ok(Category {
            id,
            name,
            is_active: true,
        })
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn deactivate_category(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    ipc_auth::authorize("deactivate_category", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let user = current_user(state.inner())?;
    require_role(&user, &[Role::Owner])?;
    db.with_tx(|tx| {
        let cat_name: String = tx
            .query_row(
                "SELECT name FROM categories WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .map_err(|_| AppError::NotFound(format!("category {id} not found")))?;
        let in_use: i64 = tx.query_row(
            "SELECT COUNT(*) FROM items WHERE category = ?1 COLLATE NOCASE",
            params![cat_name],
            |r| r.get(0),
        )?;
        if in_use > 0 {
            return Err(AppError::Conflict(format!(
                "category is referenced by {in_use} item(s); reassign the items first"
            )));
        }
        tx.execute(
            "UPDATE categories SET is_active = 0, updated_at = (unixepoch('now') * 1000) WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    })
}

const CATEGORIES_SORT_WHITELIST: &[&str] = &["name", "created_at"];

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_list_categories_paged(
    state: State<'_, AppState>,
    query: ListQuery,
) -> AppResult<ListPage<Category>> {
    let _ = require_auth("cmd_list_categories_paged", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let limit = query.limit.unwrap_or(25).clamp(1, 100);
    let offset = query.offset.unwrap_or(0).max(0);
    let sort_field = sanitize_sort(query.sort_field.as_deref(), CATEGORIES_SORT_WHITELIST, "name");
    let sort_dir = sanitize_dir(query.sort_dir.as_deref());

    db.with_raw(|c| {
        let mut wheres: Vec<String> = Vec::new();
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        let include_inactive = query
            .filters
            .get("include_inactive")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if !include_inactive {
            wheres.push("is_active = 1".to_string());
        }
        if let Some(q) = query.search.as_ref().filter(|s| !s.is_empty()) {
            wheres.push("name LIKE ?".to_string());
            params.push(Box::new(format!("%{}%", q)));
        }

        let where_refs: Vec<&str> = wheres.iter().map(|s| s.as_str()).collect();
        let order_by = format!(
            " ORDER BY {} COLLATE NOCASE {} LIMIT ? OFFSET ?",
            sort_field, sort_dir
        );
        params.push(Box::new(limit));
        params.push(Box::new(offset));

        let base_select = "SELECT id, name, is_active FROM categories";
        let count_select = "SELECT COUNT(*) FROM categories";

        let (rows, total) = paged_query(
            c,
            base_select,
            count_select,
            &where_refs,
            &order_by,
            &params,
            |r| {
                Ok(Category {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    is_active: r.get::<_, i64>(2)? != 0,
                })
            },
        )?;
        Ok(ListPage { rows, total })
    })
}

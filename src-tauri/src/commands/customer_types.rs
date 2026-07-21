//! Customer-type CRUD. Seeded with Retailer/Dealer/Painter/Contractor.
//! Only owners can mutate; anyone authenticated can read.

use crate::commands::auth::AppState;
use crate::db::list::{paged_query, sanitize_dir, sanitize_sort, ListPage, ListQuery};
use crate::error::{AppError, AppResult};
use crate::session::{require_auth, require_role, Role};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CustomerType {
    pub id: i64,
    pub name: String,
    pub is_active: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct NewCustomerType {
    pub name: String,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[tauri::command(rename_all = "snake_case")]
pub fn list_customer_types(
    state: State<'_, AppState>,
    include_inactive: Option<bool>,
) -> AppResult<Vec<CustomerType>> {
    let include_inactive = include_inactive.unwrap_or(false);
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let _ = require_auth("list_customer_types", state.inner())?; // any signed-in user
    let sql = if include_inactive {
        "SELECT id, name, is_active, created_at, updated_at FROM customer_types ORDER BY name COLLATE NOCASE"
    } else {
        "SELECT id, name, is_active, created_at, updated_at FROM customer_types WHERE is_active = 1 ORDER BY name COLLATE NOCASE"
    };
    db.with_raw(|c| {
        let mut stmt = c.prepare(sql)?;
        let rows = stmt.query_map([], |r| {
            Ok(CustomerType {
                id: r.get(0)?,
                name: r.get(1)?,
                is_active: r.get::<_, i64>(2)? != 0,
                created_at: r.get::<_, i64>(3)?.to_string(),
                updated_at: r.get::<_, i64>(4)?.to_string(),
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn add_customer_type(
    state: State<'_, AppState>,
    payload: NewCustomerType,
) -> AppResult<CustomerType> {
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let user = require_auth("add_customer_type", state.inner())?;
    require_role(&user, &[Role::Owner])?;
    let name = payload.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Validation("name is required".into()));
    }
    db.with_tx(|tx| {
        tx.execute(
            "INSERT INTO customer_types (name, is_active, created_at, updated_at) VALUES (?1, 1, 0, 0)",
            params![name],
        )?;
        let id = tx.last_insert_rowid();
        let (created_at, updated_at): (i64, i64) = tx.query_row(
            "SELECT created_at, updated_at FROM customer_types WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        Ok(CustomerType {
            id,
            name,
            is_active: true,
            created_at: created_at.to_string(),
            updated_at: updated_at.to_string(),
        })
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn rename_customer_type(
    state: State<'_, AppState>,
    id: i64,
    new_name: String,
) -> AppResult<CustomerType> {
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let user = require_auth("rename_customer_type", state.inner())?;
    require_role(&user, &[Role::Owner])?;
    let name = new_name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Validation("name is required".into()));
    }
    db.with_tx(|tx| {
        let now = now_millis();
        let updated = tx.execute(
            "UPDATE customer_types SET name = ?1, updated_at = ?2 WHERE id = ?3",
            params![name, now, id],
        )?;
        if updated == 0 {
            return Err(AppError::NotFound(format!("customer_type {id}")));
        }
        let (created_at, updated_at): (i64, i64) = tx.query_row(
            "SELECT created_at, updated_at FROM customer_types WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        Ok(CustomerType {
            id,
            name,
            is_active: true,
            created_at: created_at.to_string(),
            updated_at: updated_at.to_string(),
        })
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn deactivate_customer_type(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let user = require_auth("deactivate_customer_type", state.inner())?;
    require_role(&user, &[Role::Owner])?;
    db.with_tx(|tx| {
        // Refuse if any active customer still references this type.
        let in_use: i64 = tx.query_row(
            "SELECT COUNT(*) FROM customers WHERE customer_type_id = ?1 AND is_active = 1",
            params![id],
            |r| r.get(0),
        )?;
        if in_use > 0 {
            return Err(AppError::Conflict(format!(
                "{in_use} active customers still use this type"
            )));
        }
        let n = tx.execute(
            "UPDATE customer_types SET is_active = 0 WHERE id = ?1",
            params![id],
        )?;
        if n == 0 {
            return Err(AppError::NotFound(format!("customer_type {id}")));
        }
        Ok(())
    })
}

const CUSTOMER_TYPES_SORT_WHITELIST: &[&str] = &["name", "created_at", "updated_at"];

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_list_customer_types_paged(
    state: State<'_, AppState>,
    query: ListQuery,
) -> AppResult<ListPage<CustomerType>> {
    let _ = require_auth("cmd_list_customer_types_paged", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let limit = query.limit.unwrap_or(25).clamp(1, 100);
    let offset = query.offset.unwrap_or(0).max(0);
    let sort_field = sanitize_sort(
        query.sort_field.as_deref(),
        CUSTOMER_TYPES_SORT_WHITELIST,
        "name",
    );
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

        let base_select =
            "SELECT id, name, is_active, created_at, updated_at FROM customer_types";
        let count_select = "SELECT COUNT(*) FROM customer_types";

        let (rows, total) = paged_query(
            c,
            base_select,
            count_select,
            &where_refs,
            &order_by,
            &params,
            |r| {
                Ok(CustomerType {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    is_active: r.get::<_, i64>(2)? != 0,
                    created_at: r.get::<_, i64>(3)?.to_string(),
                    updated_at: r.get::<_, i64>(4)?.to_string(),
                })
            },
        )?;
        Ok(ListPage { rows, total })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn fresh_db() -> Db {

        Db::open_in_memory().unwrap()
    }

    #[test]
    fn add_rename_deactivate_flow() {
        let db = fresh_db();
        // owner adds a new type
        let id = db.with_raw(|c| {
            c.execute(
                "INSERT INTO customer_types (name, is_active, created_at, updated_at) VALUES ('Wholesale', 1, 0, 0)",
                [],
            )
            .unwrap();
            c.last_insert_rowid()
        });
        // rename
        db.with_raw(|c| {
            c.execute(
                "UPDATE customer_types SET name='Trade', updated_at=0 WHERE id=?1",
                [id],
            )
            .unwrap();
        });
        let n: String = db.with_raw(|c| {
            c.query_row("SELECT name FROM customer_types WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .unwrap()
        });
        assert_eq!(n, "Trade");
        // deactivate
        db.with_raw(|c| {
            c.execute("UPDATE customer_types SET is_active=0 WHERE id=?1", [id])
                .unwrap();
        });
        let active: i64 = db.with_raw(|c| {
            c.query_row(
                "SELECT is_active FROM customer_types WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .unwrap()
        });
        assert_eq!(active, 0);
    }

    #[test]
    fn cannot_deactivate_type_in_use() {
        let db = fresh_db();
        let type_id: i64 = db.with_raw(|c| {
            c.query_row(
                "SELECT id FROM customer_types WHERE name='Retailer'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        });
        db.with_raw(|c| {
            c.execute(
                "INSERT INTO customers (name, phone, created_at, updated_at) VALUES ('Cust', '9876543210', 0, 0)",
                [],
            )
            .unwrap();
            c.execute(
                "UPDATE customers SET customer_type_id = ?1 WHERE name = 'Cust'",
                [type_id],
            )
            .unwrap();
        });
        let res: AppResult<()> = db.with_tx(|tx| {
            let in_use: i64 = tx.query_row(
                "SELECT COUNT(*) FROM customers WHERE customer_type_id = ?1 AND is_active = 1",
                [type_id],
                |r| r.get(0),
            )?;
            if in_use > 0 {
                return Err(AppError::Conflict("in use".into()));
            }
            Ok(())
        });
        assert!(res.is_err());
    }
}

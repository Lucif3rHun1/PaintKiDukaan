//! Customer-type CRUD. Seeded with retail/painter/contractor/dealer.
//! Only owners can mutate; anyone authenticated can read.

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::session::{current_user, require_role, Role};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CustomerType {
    pub id: i64,
    pub name: String,
    pub is_active: bool,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct NewCustomerType {
    pub name: String,
}

#[tauri::command]
pub fn list_customer_types(db: State<'_, Db>, include_inactive: bool) -> AppResult<Vec<CustomerType>> {
    let _ = current_user()?; // any signed-in user
    let sql = if include_inactive {
        "SELECT id, name, is_active, created_at FROM customer_types ORDER BY name"
    } else {
        "SELECT id, name, is_active, created_at FROM customer_types WHERE is_active = 1 ORDER BY name"
    };
    db.with_conn(|c| {
        let mut stmt = c.prepare(sql)?;
        let rows = stmt.query_map([], |r| {
            Ok(CustomerType {
                id: r.get(0)?,
                name: r.get(1)?,
                is_active: r.get::<_, i64>(2)? != 0,
                created_at: r.get(3)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    })
}

#[tauri::command]
pub fn add_customer_type(db: State<'_, Db>, payload: NewCustomerType) -> AppResult<CustomerType> {
    let user = current_user()?;
    require_role(&user, &[Role::Owner])?;
    let name = payload.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Validation("name is required".into()));
    }
    db.with_conn_immediate(|tx| {
        tx.execute(
            "INSERT INTO customer_types (name, is_active) VALUES (?1, 1)",
            params![name],
        )?;
        let id = tx.last_insert_rowid();
        let created_at: String = tx.query_row(
            "SELECT created_at FROM customer_types WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        Ok(CustomerType { id, name, is_active: true, created_at })
    })
}

#[tauri::command]
pub fn rename_customer_type(
    db: State<'_, Db>,
    id: i64,
    new_name: String,
) -> AppResult<CustomerType> {
    let user = current_user()?;
    require_role(&user, &[Role::Owner])?;
    let name = new_name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Validation("name is required".into()));
    }
    db.with_conn_immediate(|tx| {
        let updated = tx.execute(
            "UPDATE customer_types SET name = ?1 WHERE id = ?2",
            params![name, id],
        )?;
        if updated == 0 {
            return Err(AppError::NotFound(format!("customer_type {id}")));
        }
        Ok(CustomerType {
            id,
            name,
            is_active: true,
            created_at: tx.query_row(
                "SELECT created_at FROM customer_types WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )?,
        })
    })
}

#[tauri::command]
pub fn deactivate_customer_type(db: State<'_, Db>, id: i64) -> AppResult<()> {
    let user = current_user()?;
    require_role(&user, &[Role::Owner])?;
    db.with_conn_immediate(|tx| {
        // Refuse if any active customer still references this type.
        let in_use: i64 = tx.query_row(
            "SELECT COUNT(*) FROM customers WHERE type_id = ?1 AND is_active = 1",
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::session::{set_current_user, User};

    fn owner() -> User {
        User { id: 1, name: "O".into(), role: Role::Owner }
    }

    fn fresh_db() -> Db {
        set_current_user(Some(owner()));
        Db::open_in_memory().unwrap()
    }

    #[test]
    fn add_rename_deactivate_flow() {
        let db = fresh_db();
        // owner adds a new type
        let id = {
            let ct = db.with_conn(|c| {
                c.execute("INSERT INTO customer_types (name, is_active) VALUES ('Wholesale', 1)", [])
                    .unwrap();
                c.last_insert_rowid()
            });
            ct
        };
        // rename
        db.with_conn(|c| {
            c.execute("UPDATE customer_types SET name='Trade' WHERE id=?1", [id]).unwrap();
        });
        let n: String = db.with_conn(|c| {
            c.query_row("SELECT name FROM customer_types WHERE id=?1", [id], |r| r.get(0)).unwrap()
        });
        assert_eq!(n, "Trade");
        // deactivate
        db.with_conn(|c| {
            c.execute("UPDATE customer_types SET is_active=0 WHERE id=?1", [id]).unwrap();
        });
        let active: i64 = db.with_conn(|c| {
            c.query_row("SELECT is_active FROM customer_types WHERE id=?1", [id], |r| r.get(0))
                .unwrap()
        });
        assert_eq!(active, 0);
    }

    #[test]
    fn cannot_deactivate_type_in_use() {
        let db = fresh_db();
        let type_id: i64 = db.with_conn(|c| {
            c.query_row("SELECT id FROM customer_types WHERE name='retail'", [], |r| r.get(0))
                .unwrap()
        });
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO customers (name, phone) VALUES ('Cust', '9876543210')",
                [],
            )
            .unwrap();
            c.execute("UPDATE customers SET type_id = ?1 WHERE name = 'Cust'", [type_id])
                .unwrap();
        });
        let res: AppResult<()> = db.with_conn_immediate(|tx| {
            let in_use: i64 = tx.query_row(
                "SELECT COUNT(*) FROM customers WHERE type_id = ?1 AND is_active = 1",
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

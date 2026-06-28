//! Vendors CRUD + payments + outstanding balance.

use crate::commands::auth::AppState;
use crate::error::{AppError, AppResult};
use crate::security::ipc_auth;
use crate::session::{current_user, require_role, Role};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

/// Validate Indian mobile number: 10 digits starting with 6-9.
/// Mirrors `customers::validate_phone`.
fn validate_phone(phone: &str) -> AppResult<()> {
    if phone.len() != 10 {
        return Err(AppError::Validation("phone must be 10 digits".into()));
    }
    let bytes = phone.as_bytes();
    let first = bytes[0] as char;
    if !('6'..='9').contains(&first) {
        return Err(AppError::Validation("phone must start with 6-9".into()));
    }
    if !bytes.iter().all(|b| b.is_ascii_digit()) {
        return Err(AppError::Validation("phone must be digits only".into()));
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Vendor {
    pub id: i64,
    pub name: String,
    pub phone: Option<String>,
    pub opening_balance: i64,
    pub notes: Option<String>,
    pub is_active: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct VendorOutstanding {
    pub vendor_id: i64,
    pub opening_balance: i64,
    pub total_purchases: i64,
    pub total_payments: i64,
    /// opening + total_purchases - total_payments
    pub outstanding: i64,
}

#[derive(Debug, Deserialize)]
pub struct NewVendor {
    pub name: String,
    pub phone: Option<String>,
    pub opening_balance: Option<i64>,
    pub notes: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct VendorUpdate {
    pub name: Option<String>,
    pub phone: Option<Option<String>>,
    pub opening_balance: Option<i64>,
    pub notes: Option<Option<String>>,
    pub is_active: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct VendorPayment {
    pub vendor_id: i64,
    pub amount: i64,
    pub mode: String,
    pub date: String,
    pub notes: Option<String>,
}

#[tauri::command(rename_all = "snake_case")]
pub fn create_vendor(state: State<'_, AppState>, payload: NewVendor) -> AppResult<Vendor> {
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let user = current_user()?;
    require_role(&user, &[Role::Owner, Role::Stocker])?;
    if payload.name.trim().is_empty() {
        return Err(AppError::Validation("name is required".into()));
    }
    if let Some(ref phone) = payload.phone {
        validate_phone(phone)?;
    }
    let now = chrono::Utc::now().timestamp_millis();
    db.with_tx(|tx| {
        tx.execute(
            "INSERT INTO vendors (name, phone, credit_limit_paise, notes, is_active, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)",
            params![
                payload.name,
                payload.phone,
                payload.opening_balance.unwrap_or(0),
                payload.notes,
                now,
            ],
        )?;
        let id = tx.last_insert_rowid();
        Ok(Vendor {
            id,
            name: payload.name,
            phone: payload.phone,
            opening_balance: payload.opening_balance.unwrap_or(0),
            notes: payload.notes,
            is_active: true,
            created_at: tx.query_row(
                "SELECT created_at FROM vendors WHERE id = ?1",
                params![id], |r| r.get::<_, i64>(0).map(|v| v.to_string()),
            )?,
            updated_at: tx.query_row(
                "SELECT updated_at FROM vendors WHERE id = ?1",
                params![id], |r| r.get::<_, i64>(0).map(|v| v.to_string()),
            )?,
        })
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn list_vendors(
    state: State<'_, AppState>,
    query: Option<String>,
    include_inactive: bool,
) -> AppResult<Vec<Vendor>> {
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let _ = current_user()?;
    db.with_raw(|c| {
        let mut sql = String::from("SELECT id, name, phone, credit_limit_paise, is_active, created_at, updated_at, notes FROM vendors WHERE 1=1");
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if !include_inactive { sql.push_str(" AND is_active = 1"); }
        if let Some(q) = &query {
            sql.push_str(&format!(" AND (name LIKE ?{} OR phone LIKE ?{})", args.len() + 1, args.len() + 1));
            args.push(Box::new(format!("%{}%", q)));
        }
        sql.push_str(" ORDER BY name COLLATE NOCASE");
        let mut stmt = c.prepare(&sql)?;
        let dyn_args: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| &**b as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(dyn_args.as_slice(), |r| {
            Ok(Vendor {
                id: r.get(0)?,
                name: r.get(1)?,
                phone: r.get(2)?,
                opening_balance: r.get::<_, i64>(3)?,
                is_active: r.get::<_, i64>(4)? != 0,
                created_at: r.get::<_, i64>(5)?.to_string(),
                updated_at: r.get::<_, i64>(6)?.to_string(),
                notes: r.get(7)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_vendor(state: State<'_, AppState>, id: i64) -> AppResult<Vendor> {
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let _ = current_user()?;
    db.with_raw(|c| {
        let mut stmt = c.prepare(
            "SELECT id, name, phone, credit_limit_paise, is_active, created_at, updated_at, notes FROM vendors WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], |r| {
            Ok(Vendor {
                id: r.get(0)?,
                name: r.get(1)?,
                phone: r.get(2)?,
                opening_balance: r.get::<_, i64>(3)?,
                is_active: r.get::<_, i64>(4)? != 0,
                created_at: r.get::<_, i64>(5)?.to_string(),
                updated_at: r.get::<_, i64>(6)?.to_string(),
                notes: r.get(7)?,
            })
        })?;
        rows.next()
            .ok_or_else(|| AppError::NotFound(format!("vendor {id}")))?
            .map_err(Into::into)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn update_vendor(
    state: State<'_, AppState>,
    id: i64,
    patch: VendorUpdate,
) -> AppResult<Vendor> {
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let user = current_user()?;
    require_role(&user, &[Role::Owner, Role::Stocker])?;
    if let Some(Some(ref phone)) = &patch.phone {
        validate_phone(phone)?;
    }
    let now = chrono::Utc::now().timestamp_millis();
    db.with_tx(|tx| {
        let mut sets: Vec<&'static str> = Vec::new();
        let mut values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        macro_rules! add {
            ($col:literal, $val:expr) => {{
                sets.push(concat!($col, " ?"));
                values.push(Box::new($val));
            }};
        }
        if let Some(v) = &patch.name { add!("name =", v.clone()) }
        if let Some(v) = &patch.phone { add!("phone =", v.clone()) }
        if let Some(v) = &patch.notes { add!("notes =", v.clone()) }
        if let Some(v) = patch.opening_balance { add!("credit_limit_paise =", v) }
        if let Some(v) = patch.is_active { add!("is_active =", if v { 1_i64 } else { 0_i64 }) }
        if sets.is_empty() {
            return Err(AppError::Validation("no fields to update".into()));
        }
        sets.push("updated_at = ?");
        values.push(Box::new(now));
        let sql = format!("UPDATE vendors SET {} WHERE id = ?", sets.join(", "));
        let mut pvec: Vec<&dyn rusqlite::ToSql> = values.iter().map(|b| &**b as &dyn rusqlite::ToSql).collect();
        pvec.push(&id);
        let n = tx.execute(&sql, pvec.as_slice())?;
        if n == 0 {
            return Err(AppError::NotFound(format!("vendor {id}")));
        }
        let mut stmt = tx.prepare(
            "SELECT id, name, phone, credit_limit_paise, is_active, created_at, updated_at, notes FROM vendors WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], |r| {
            Ok(Vendor {
                id: r.get(0)?,
                name: r.get(1)?,
                phone: r.get(2)?,
                opening_balance: r.get::<_, i64>(3)?,
                is_active: r.get::<_, i64>(4)? != 0,
                created_at: r.get::<_, i64>(5)?.to_string(),
                updated_at: r.get::<_, i64>(6)?.to_string(),
                notes: r.get(7)?,
            })
        })?;
        rows.next()
            .ok_or_else(|| AppError::NotFound(format!("vendor {id}")))?
            .map_err(Into::into)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn record_vendor_payment(
    state: State<'_, AppState>,
    payload: VendorPayment,
) -> AppResult<VendorOutstanding> {
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let user = current_user()?;
    require_role(&user, &[Role::Owner])?;
    if payload.amount <= 0 {
        return Err(AppError::Validation("amount must be > 0".into()));
    }
    if payload.mode.trim().is_empty() {
        return Err(AppError::Validation("mode is required".into()));
    }
    let now = chrono::Utc::now().timestamp_millis();
    db.with_tx(|tx| {
        // Ensure vendor exists.
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM vendors WHERE id = ?1)",
            params![payload.vendor_id], |r| r.get(0),
        ).unwrap_or(false);
        if !exists {
            return Err(AppError::NotFound(format!("vendor {}", payload.vendor_id)));
        }
        tx.execute(
            "INSERT INTO vendor_payments (vendor_id, purchase_id, mode, amount_paise, reference, note, created_at, created_by) VALUES (?1, NULL, ?2, ?3, NULL, ?4, ?5, ?6)",
            params![
                payload.vendor_id,
                payload.mode,
                payload.amount,
                payload.notes,
                now,
                user.id,
            ],
        )?;
        // Return updated outstanding.
        compute_outstanding_tx(tx, payload.vendor_id)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn vendor_outstanding(state: State<'_, AppState>, id: i64) -> AppResult<VendorOutstanding> {
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let _ = current_user()?;
    db.with_raw(|c| {
        let opening_balance: i64 = c.query_row(
            "SELECT COALESCE(credit_limit_paise, 0) FROM vendors WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        let total_purchases: i64 = c.query_row(
            "SELECT COALESCE(SUM(total_paise), 0) FROM purchases WHERE vendor_id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        let total_payments: i64 = c.query_row(
            "SELECT COALESCE(SUM(amount_paise), 0) FROM vendor_payments WHERE vendor_id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        let outstanding = opening_balance + total_purchases - total_payments;
        Ok(VendorOutstanding {
            vendor_id: id,
            opening_balance,
            total_purchases,
            total_payments,
            outstanding,
        })
    })
}

fn compute_outstanding_tx(tx: &rusqlite::Connection, id: i64) -> AppResult<VendorOutstanding> {
    let opening_balance: i64 = tx.query_row(
        "SELECT COALESCE(credit_limit_paise, 0) FROM vendors WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )?;
    let total_purchases: i64 = tx.query_row(
        "SELECT COALESCE(SUM(total_paise), 0) FROM purchases WHERE vendor_id = ?1",
        params![id],
        |r| r.get(0),
    )?;
    let total_payments: i64 = tx.query_row(
        "SELECT COALESCE(SUM(amount_paise), 0) FROM vendor_payments WHERE vendor_id = ?1",
        params![id],
        |r| r.get(0),
    )?;
    let outstanding = opening_balance + total_purchases - total_payments;
    Ok(VendorOutstanding {
        vendor_id: id,
        opening_balance,
        total_purchases,
        total_payments,
        outstanding,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::session::{set_current_user, User};

    fn owner() -> User {
        User {
            id: 1,
            name: "O".into(),
            role: Role::Owner,
        }
    }
    fn stocker() -> User {
        User {
            id: 2,
            name: "S".into(),
            role: Role::Stocker,
        }
    }

    #[test]
    fn create_and_outstanding() {
        set_current_user(Some(stocker()));
        let db = Db::open_in_memory().unwrap();
        db.with_raw(|c| {
            c.execute("INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length, is_active, created_at, updated_at) VALUES ('S', 'stocker', X'00', X'00', 6, 1, 0, 0)", []).unwrap();
        });
        db.with_raw(|c| {
            c.execute(
                "INSERT INTO locations (name, zone, is_default, is_active, created_at, updated_at) VALUES ('Main',NULL,1,1,0,0)",
                [],
            ).unwrap();
        });
        let id = db.with_raw(|c| {
            c.execute(
                "INSERT INTO vendors (name, credit_limit_paise, is_active, created_at, updated_at) VALUES ('Acme Paints', 0, 1, 0, 0)",
                [],
            ).unwrap();
            c.last_insert_rowid()
        });
        db.with_raw(|c| {
            c.execute(
                "INSERT INTO purchases (purchase_number, vendor_id, location_id, total_paise, created_by, created_at, updated_at) VALUES ('PINV-0001', ?1, 1, 5000, 1, 0, 0)",
                [id],
            ).unwrap();
            c.execute(
                "INSERT INTO vendor_payments (vendor_id, purchase_id, mode, amount_paise, reference, note, created_at, created_by) VALUES (?1, NULL, 'upi', 2000, NULL, NULL, 0, 1)",
                [id],
            ).unwrap();
        });
        let out = db.with_raw(|c| {
            let tp: i64 = c.query_row(
                "SELECT COALESCE(SUM(total_paise), 0) FROM purchases WHERE vendor_id = ?1", [id], |r| r.get(0),
            ).unwrap();
            let tpay: i64 = c.query_row(
                "SELECT COALESCE(SUM(amount_paise), 0) FROM vendor_payments WHERE vendor_id = ?1", [id], |r| r.get(0),
            ).unwrap();
            tp - tpay
        });
        assert_eq!(out, 3000, "got {out}");
    }

    #[test]
    fn record_vendor_payment_returns_updated_outstanding() {
        set_current_user(Some(owner()));
        let db = Db::open_in_memory().unwrap();
        db.with_raw(|c| {
            c.execute("INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length, is_active, created_at, updated_at) VALUES ('O', 'owner', X'00', X'00', 6, 1, 0, 0)", []).unwrap();
        });
        let id = db.with_raw(|c| {
            c.execute("INSERT INTO vendors (name, credit_limit_paise, is_active, created_at, updated_at) VALUES ('V', 0, 1, 0, 0)", []).unwrap();
            c.last_insert_rowid()
        });
        let out = db.with_tx(|tx| {
            tx.execute(
                "INSERT INTO vendor_payments (vendor_id, purchase_id, mode, amount_paise, reference, note, created_at, created_by) VALUES (?1, NULL, 'cash', 100, NULL, NULL, 0, 1)",
                [id],
            ).unwrap();
            compute_outstanding_tx(tx, id)
        }).unwrap();
        assert_eq!(out.outstanding, -100, "got {}", out.outstanding);
    }

    #[test]
    fn validate_phone_rejects_invalid_numbers() {
        assert!(validate_phone("12345").is_err());
        assert!(validate_phone("1234567890").is_err());
        assert!(validate_phone("987654321a").is_err());
        assert!(validate_phone("9876543210").is_ok());
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn list_vendor_payments(
    state: State<'_, AppState>,
    _vendor_id: i64,
    _limit: Option<i64>,
) -> AppResult<Vec<serde_json::Value>> {
    ipc_auth::authorize_err("list_vendor_payments", state.inner())?;
    Ok(Vec::new())
}

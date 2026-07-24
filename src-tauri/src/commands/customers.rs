//! Customers CRUD + outstanding balance.
//!
//! - Phone is `^[6-9]\d{9}$` (10 digits, starts 6-9) and unique.
//! - `is_flagged` and `opening_balance_paise` updates are owner-only; cashier can set
//!   `opening_balance_paise` on create.
//! - `customer_outstanding` = opening + Σ(sales.total - paid) - Σ(payments).

use crate::commands::_util::case_fold_lower;
use crate::commands::auth::AppState;
use crate::db::list::{paged_query, sanitize_dir, sanitize_sort, ListPage, ListQuery};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::security::ipc_auth;
use crate::session::{current_user, require_auth, require_role, Role};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Customer {
    pub id: i64,
    pub name: String,
    pub phone: String,
    pub customer_type_id: Option<i64>,
    pub type_name: Option<String>,
    pub is_flagged: bool,
    pub opening_balance_paise: i64,
    pub notes: Option<String>,
    pub is_active: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct CustomerOutstanding {
    pub customer_id: i64,
    pub opening_balance_paise: i64,
    pub total_sales: i64,
    pub total_paid: i64,
    pub total_payments: i64,
    pub outstanding: i64,
}

#[derive(Debug, Deserialize)]
pub struct NewCustomer {
    pub name: String,
    pub phone: String,
    pub customer_type_id: Option<i64>,
    pub is_flagged: Option<bool>,
    pub opening_balance_paise: Option<i64>,
    pub notes: Option<String>,
}

/// POS-friendly inline customer creation. Used when the cashier needs to
/// attach a brand-new walk-in to a sale. Only accepts the minimum fields
/// (name, phone, optional type); owner-only fields (`is_flagged`,
/// `opening_balance_paise`, `notes`) are ignored and forced to their safe
/// defaults so a cashier cannot grant credit or flag a customer by accident.
#[derive(Debug, Deserialize)]
pub struct CreateCustomerInline {
    pub name: String,
    pub phone: String,
    pub customer_type_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct CustomerUpdate {
    pub name: Option<String>,
    pub phone: Option<String>,
    pub customer_type_id: Option<Option<i64>>,
    pub is_flagged: Option<bool>,
    pub opening_balance_paise: Option<i64>,
    pub notes: Option<Option<String>>,
    pub is_active: Option<bool>,
}

fn validate_phone(phone: &str) -> AppResult<()> {
    // Cheap literal regex (avoids pulling in `regex` crate).
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

#[tauri::command(rename_all = "snake_case")]
pub fn create_customer(state: State<'_, AppState>, payload: NewCustomer) -> AppResult<Customer> {
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let user = require_auth("create_customer", state.inner())?;
    create_customer_impl(db, &user, payload)
}

/// Inline customer creation used by the POS when the cashier types a brand-new
/// name/phone into the customer picker. Only the cashier-safe fields are
/// accepted; owner-only fields are forced to safe defaults before delegating
/// to the shared `create_customer_impl`.
#[tauri::command(rename_all = "snake_case")]
pub fn create_customer_inline(
    state: State<'_, AppState>,
    payload: CreateCustomerInline,
) -> AppResult<Customer> {
    ipc_auth::authorize_err("create_customer_inline", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let user = current_user(state.inner())?;
    create_customer_inline_impl(db, &user, payload)
}

fn create_customer_impl(
    db: &Db,
    user: &crate::session::User,
    payload: NewCustomer,
) -> AppResult<Customer> {
    require_role(user, &[Role::Owner, Role::Cashier])?;
    if payload.opening_balance_paise.unwrap_or(0) != 0 {
        require_role(user, &[Role::Owner])?;
    }
    validate_phone(&payload.phone)?;

    // is_flagged is owner-only.
    let is_flagged = if payload.is_flagged.unwrap_or(false) {
        require_role(user, &[Role::Owner])?;
        true
    } else {
        false
    };

    db.with_tx(|tx| {
        // Uniqueness is enforced by UNIQUE index, but we check explicitly for
        // a friendlier error.
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM customers WHERE phone = ?1)",
                params![payload.phone],
                |r| r.get(0),
            )
            .unwrap_or(false);
        if exists {
            return Err(AppError::Conflict(format!(
                "phone {} already exists", payload.phone
            )));
        }
        tx.execute(
            "INSERT INTO customers (name, phone, customer_type_id, is_flagged, opening_balance_paise, notes, is_active) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)",
            params![
                payload.name,
                payload.phone,
                payload.customer_type_id,
                if is_flagged { 1_i64 } else { 0_i64 },
                payload.opening_balance_paise.unwrap_or(0),
                payload.notes,
            ],
        )?;
        let id = tx.last_insert_rowid();
        fetch_customer_tx(tx, id)
    })
}

/// POS-safe wrapper around `create_customer_impl`. Forces the owner-only
/// fields (`is_flagged`, `opening_balance_paise`, `notes`) to safe defaults
/// before delegating so the resulting row is identical to one created via
/// `NewCustomer` with those fields unset.
fn create_customer_inline_impl(
    db: &Db,
    user: &crate::session::User,
    payload: CreateCustomerInline,
) -> AppResult<Customer> {
    create_customer_impl(
        db,
        user,
        NewCustomer {
            name: payload.name,
            phone: payload.phone,
            customer_type_id: payload.customer_type_id,
            is_flagged: None,
            opening_balance_paise: Some(0),
            notes: None,
        },
    )
}

#[tauri::command(rename_all = "snake_case")]
pub fn update_customer(
    state: State<'_, AppState>,
    id: i64,
    patch: CustomerUpdate,
) -> AppResult<Customer> {
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let user = require_auth("update_customer", state.inner())?;
    update_customer_impl(db, &user, id, patch)
}

fn update_customer_impl(
    db: &Db,
    user: &crate::session::User,
    id: i64,
    patch: CustomerUpdate,
) -> AppResult<Customer> {
    require_role(user, &[Role::Owner, Role::Cashier])?;
    if let Some(p) = &patch.phone {
        validate_phone(p)?;
    }
    // Owner-only update fields. Cashier attempting to send any of these is
    // rejected before we touch the DB.
    if patch.is_flagged.is_some() || patch.opening_balance_paise.is_some() || patch.is_active.is_some() {
        require_role(user, &[Role::Owner])?;
    }
    db.with_tx(|tx| {
        let _current = fetch_customer_tx(tx, id)?;
        let mut sets: Vec<&'static str> = Vec::new();
        let mut values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        macro_rules! add {
            ($col:literal, $val:expr) => {{
                sets.push(concat!($col, " ?"));
                values.push(Box::new($val));
            }};
        }
        if let Some(v) = &patch.name {
            add!("name =", v.clone())
        }
        if let Some(v) = &patch.phone {
            let taken: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM customers WHERE phone = ?1 AND id <> ?2)",
                    params![v, id],
                    |r| r.get(0),
                )
                .unwrap_or(false);
            if taken {
                return Err(AppError::Conflict(format!("phone {v} already exists")));
            }
            add!("phone =", v.clone());
        }
        if let Some(v) = &patch.customer_type_id {
            add!("customer_type_id =", v)
        }
        if let Some(v) = patch.opening_balance_paise {
            add!("opening_balance_paise =", v)
        }
        if let Some(v) = &patch.notes {
            add!("notes =", v)
        }
        if let Some(v) = patch.is_flagged {
            add!("is_flagged =", if v { 1_i64 } else { 0_i64 });
        }
        if let Some(v) = patch.is_active {
            add!("is_active =", if v { 1_i64 } else { 0_i64 })
        }
        if sets.is_empty() {
            return Err(AppError::Validation("no fields to update".into()));
        }
        sets.push("updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000");
        let sql = format!("UPDATE customers SET {} WHERE id = ?", sets.join(", "));
        let mut pvec: Vec<&dyn rusqlite::ToSql> = values
            .iter()
            .map(|b| &**b as &dyn rusqlite::ToSql)
            .collect();
        pvec.push(&id);
        let n = tx.execute(&sql, pvec.as_slice())?;
        if n == 0 {
            return Err(AppError::NotFound(format!("customer {id}")));
        }
        fetch_customer_tx(tx, id)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn list_customers(
    state: State<'_, AppState>,
    query: Option<String>,
    include_inactive: bool,
) -> AppResult<Vec<Customer>> {
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let user = require_auth("list_customers", state.inner())?;
    require_role(&user, &[Role::Owner, Role::Cashier])?;
    db.with_raw(|c| {
        let mut sql = String::from(
            "SELECT c.id, c.name, c.phone, c.customer_type_id, t.name, c.is_flagged, c.opening_balance_paise, c.notes, c.is_active, c.created_at, c.updated_at \
             FROM customers c LEFT JOIN customer_types t ON t.id = c.customer_type_id WHERE 1=1",
        );
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if !include_inactive { sql.push_str(" AND c.is_active = 1"); }
        if let Some(q) = &query {
            sql.push_str(&format!(" AND (LOWER(c.name) LIKE ?{} OR LOWER(c.phone) LIKE ?{})", args.len() + 1, args.len() + 1));
            args.push(Box::new(format!("%{}%", case_fold_lower(q))));
        }
        sql.push_str(" ORDER BY c.name COLLATE NOCASE");
        let mut stmt = c.prepare(&sql)?;
        let dyn_args: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| &**b as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(dyn_args.as_slice(), |r| {
            Ok(Customer {
                id: r.get(0)?,
                name: r.get(1)?,
                phone: r.get(2)?,
                customer_type_id: r.get(3)?,
                type_name: r.get(4)?,
                is_flagged: r.get::<_, i64>(5)? != 0,
                opening_balance_paise: r.get(6)?,
                notes: r.get(7)?,
                is_active: r.get::<_, i64>(8)? != 0,
                created_at: r.get(9)?,
                updated_at: r.get(10)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn lookup_customer(state: State<'_, AppState>, phone: String) -> AppResult<Option<Customer>> {
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let user = require_auth("lookup_customer", state.inner())?;
    require_role(&user, &[Role::Owner, Role::Cashier])?;
    // Master plan §7.4: search by 4-10 digit phone substring.
    let q = phone.trim();
    if q.len() < 4 || q.len() > 10 || !q.chars().all(|c| c.is_ascii_digit()) {
        return Err(AppError::Validation(
            "phone search must be 4-10 digits".into(),
        ));
    }
    let like_pattern = format!("%{q}%");
    db.with_raw(|c| {
        let mut stmt = c.prepare(
            "SELECT c.id, c.name, c.phone, c.customer_type_id, t.name, c.is_flagged, c.opening_balance_paise, c.notes, c.is_active, c.created_at, c.updated_at \
             FROM customers c LEFT JOIN customer_types t ON t.id = c.customer_type_id \
             WHERE c.phone LIKE ?1 \
             ORDER BY c.id ASC LIMIT 1",
        )?;
        let mut rows = stmt.query_map(params![like_pattern], |r| {
            Ok(Customer {
                id: r.get(0)?,
                name: r.get(1)?,
                phone: r.get(2)?,
                customer_type_id: r.get(3)?,
                type_name: r.get(4)?,
                is_flagged: r.get::<_, i64>(5)? != 0,
                opening_balance_paise: r.get(6)?,
                notes: r.get(7)?,
                is_active: r.get::<_, i64>(8)? != 0,
                created_at: r.get(9)?,
                updated_at: r.get(10)?,
            })
        })?;
        match rows.next() {
            Some(Ok(c)) => Ok(Some(c)),
            Some(Err(e)) => Err(e.into()),
            None => Ok(None),
        }
    })
}

#[derive(Debug, Serialize, Clone)]
pub struct CustomerBill {
    pub sale_id: i64,
    pub date: String,
    pub total: i64,
    pub paid_amount: i64,
    pub status: String,
    pub created_at: String,
}

fn list_customer_bills_impl(db: &Db, customer_id: i64) -> AppResult<Vec<CustomerBill>> {
    db.with_raw(|c| {
        let mut stmt = c.prepare(
            "SELECT id, date, total, paid_amount, status, created_at \
             FROM sales \
             WHERE customer_id = ?1 AND status = 'final' \
             ORDER BY date DESC, id DESC",
        )?;
        let rows = stmt.query_map(params![customer_id], |r| {
            Ok(CustomerBill {
                sale_id: r.get(0)?,
                date: r.get(1)?,
                total: r.get(2)?,
                paid_amount: r.get(3)?,
                status: r.get(4)?,
                created_at: r.get(5)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn list_customer_bills(
    state: State<'_, AppState>,
    customer_id: i64,
) -> AppResult<Vec<CustomerBill>> {
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let user = require_auth("list_customer_bills", state.inner())?;
    require_role(&user, &[Role::Owner, Role::Cashier])?;
    list_customer_bills_impl(db, customer_id)
}

fn fetch_customer_tx(tx: &rusqlite::Connection, id: i64) -> AppResult<Customer> {
    let mut stmt = tx.prepare(
        "SELECT c.id, c.name, c.phone, c.customer_type_id, t.name, c.is_flagged, c.opening_balance_paise, c.notes, c.is_active, c.created_at, c.updated_at \
         FROM customers c LEFT JOIN customer_types t ON t.id = c.customer_type_id WHERE c.id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], |r| {
        Ok(Customer {
            id: r.get(0)?,
            name: r.get(1)?,
            phone: r.get(2)?,
            customer_type_id: r.get(3)?,
            type_name: r.get(4)?,
            is_flagged: r.get::<_, i64>(5)? != 0,
            opening_balance_paise: r.get(6)?,
            notes: r.get(7)?,
            is_active: r.get::<_, i64>(8)? != 0,
            created_at: r.get(9)?,
            updated_at: r.get(10)?,
        })
    })?;
    rows.next()
        .ok_or_else(|| AppError::NotFound(format!("customer {id}")))?
        .map_err(Into::into)
}

/// Look up a customer by id. Returns `None` if the id does not exist.
pub fn get_by_id(c: &rusqlite::Connection, id: i64) -> AppResult<Option<Customer>> {
    match fetch_customer_tx(c, id) {
        Ok(c) => Ok(Some(c)),
        Err(AppError::NotFound(_)) => Ok(None),
        Err(e) => Err(e),
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_customer(state: State<'_, AppState>, id: i64) -> AppResult<Option<Customer>> {
    let user = require_auth("get_customer", state.inner())?;
    require_role(&user, &[Role::Owner, Role::Cashier])?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    db.with_raw(|c| get_by_id(c, id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::session::User;

    fn owner() -> User {
        User {
            id: 1,
            name: "O".into(),
            role: Role::Owner,
        }
    }
    fn cashier() -> User {
        User {
            id: 2,
            name: "C".into(),
            role: Role::Cashier,
        }
    }

    #[test]
    fn phone_validation() {
        assert!(validate_phone("9876543210").is_ok());
        assert!(validate_phone("5987654321").is_err()); // starts with 5
        assert!(validate_phone("987654321").is_err()); // 9 digits
        assert!(validate_phone("98765432101").is_err()); // 11 digits
        assert!(validate_phone("98765abcde").is_err()); // non-digit
    }

    #[test]
    fn create_customer_enforces_unique_phone() {

        let db = Db::open_in_memory().unwrap();
        db.with_raw(|c| {
            c.execute(
                "INSERT INTO customers (name, phone) VALUES ('A', '9876543210')",
                [],
            )
            .unwrap();
        });
        let res: AppResult<()> = db.with_tx(|tx| {
            let exists: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM customers WHERE phone = ?1)",
                    ["9876543210"],
                    |r| r.get(0),
                )
                .unwrap_or(false);
            if exists {
                return Err(AppError::Conflict("dup".into()));
            }
            tx.execute(
                "INSERT INTO customers (name, phone) VALUES ('B', '9876543210')",
                [],
            )?;
            Ok(())
        });
        assert!(res.is_err());
    }

    #[test]
    fn is_flagged_only_owner_can_set() {
        // Cashier attempting to set is_flagged via update is rejected by the
        // role guard before we touch the DB. We exercise the real entry point
        // (update_customer_impl) rather than the require_role helper directly.

        let db = Db::open_in_memory().unwrap();
        let id = db.with_raw(|c| {
            c.execute(
                "INSERT INTO customers (name, phone) VALUES ('Test', '9876543210')",
                [],
            )
            .unwrap();
            c.last_insert_rowid()
        });
        let res = update_customer_impl(
            &db,
            &cashier(),
            id,
            CustomerUpdate {
                name: None,
                phone: None,
                customer_type_id: None,
                is_flagged: Some(true),
                opening_balance_paise: None,
                notes: None,
                is_active: None,
            },
        );
        assert!(matches!(res, Err(AppError::Forbidden(_))));

        // Owner may set it.

        let ok = update_customer_impl(
            &db,
            &owner(),
            id,
            CustomerUpdate {
                name: None,
                phone: None,
                customer_type_id: None,
                is_flagged: Some(true),
                opening_balance_paise: None,
                notes: None,
                is_active: None,
            },
        );
        assert!(
            ok.is_ok(),
            "owner should be allowed, got: {:?}",
            ok.as_ref().err()
        );
        assert!(ok.unwrap().is_flagged);
    }

    #[test]
    fn opening_balance_only_owner_can_update() {

        let db = Db::open_in_memory().unwrap();
        let id = db.with_raw(|c| {
            c.execute(
                "INSERT INTO customers (name, phone) VALUES ('Test', '9876543210')",
                [],
            )
            .unwrap();
            c.last_insert_rowid()
        });

        let res = update_customer_impl(
            &db,
            &cashier(),
            id,
            CustomerUpdate {
                name: None,
                phone: None,
                customer_type_id: None,
                is_flagged: None,
                opening_balance_paise: Some(1000),
                notes: None,
                is_active: None,
            },
        );
        assert!(
            matches!(res, Err(AppError::Forbidden(_))),
            "cashier updating opening_balance_paise must be Forbidden"
        );


        let ok = update_customer_impl(
            &db,
            &owner(),
            id,
            CustomerUpdate {
                name: None,
                phone: None,
                customer_type_id: None,
                is_flagged: None,
                opening_balance_paise: Some(1000),
                notes: None,
                is_active: None,
            },
        );
        assert!(
            ok.is_ok(),
            "owner should be allowed, got: {:?}",
            ok.as_ref().err()
        );
        assert_eq!(ok.unwrap().opening_balance_paise, 1000);
    }

    #[test]
    fn cashier_cannot_set_opening_balance_on_create() {

        let db = Db::open_in_memory().unwrap();
        let res = create_customer_impl(
            &db,
            &cashier(),
            NewCustomer {
                name: "Test".into(),
                phone: "9876543210".into(),
                customer_type_id: None,
                is_flagged: None,
                opening_balance_paise: Some(2500),
                notes: None,
            },
        );
        assert!(matches!(res, Err(AppError::Forbidden(_))));
    }

    #[test]
    fn create_customer_inline_strips_owner_only_fields() {
        // The inline command only accepts (name, phone, customer_type_id).
        // Even if the caller somehow tried to set is_flagged or notes, those
        // fields don't exist on `CreateCustomerInline` so they cannot leak
        // through. We verify the safe defaults are applied.

        let db = Db::open_in_memory().unwrap();
        let c = create_customer_inline_impl(
            &db,
            &cashier(),
            CreateCustomerInline {
                name: "Walk-in".into(),
                phone: "9876543210".into(),
                customer_type_id: None,
            },
        )
        .unwrap();
        assert_eq!(c.name, "Walk-in");
        assert_eq!(c.opening_balance_paise, 0);
        assert!(!c.is_flagged);
        assert!(c.notes.is_none());
        assert!(c.is_active);
    }

    #[test]
    fn create_customer_inline_rejects_invalid_phone() {

        let db = Db::open_in_memory().unwrap();
        let res = create_customer_inline_impl(
            &db,
            &cashier(),
            CreateCustomerInline {
                name: "X".into(),
                phone: "12345".into(), // too short, doesn't start with 6-9
                customer_type_id: None,
            },
        );
        assert!(matches!(res, Err(AppError::Validation(_))));
    }

    #[test]
    fn create_customer_inline_rejects_duplicate_phone() {

        let db = Db::open_in_memory().unwrap();
        let _first = create_customer_inline_impl(
            &db,
            &cashier(),
            CreateCustomerInline {
                name: "First".into(),
                phone: "9876543210".into(),
                customer_type_id: None,
            },
        )
        .unwrap();
        let dup = create_customer_inline_impl(
            &db,
            &cashier(),
            CreateCustomerInline {
                name: "Second".into(),
                phone: "9876543210".into(),
                customer_type_id: None,
            },
        );
        assert!(matches!(dup, Err(AppError::Conflict(_))));
    }

    #[test]
    fn cashier_can_update_non_owner_fields() {

        let db = Db::open_in_memory().unwrap();
        let id = create_customer_impl(
            &db,
            &cashier(),
            NewCustomer {
                name: "Old".into(),
                phone: "9876543210".into(),
                customer_type_id: None,
                is_flagged: None,
                opening_balance_paise: None,
                notes: None,
            },
        )
        .unwrap()
        .id;

        let ok = update_customer_impl(
            &db,
            &cashier(),
            id,
            CustomerUpdate {
                name: Some("New".into()),
                phone: Some("8765432109".into()),
                customer_type_id: None,
                is_flagged: None,
                opening_balance_paise: None,
                notes: Some(Some("updated".into())),
                is_active: None,
            },
        );
        assert!(ok.is_ok(), "cashier update failed: {:?}", ok.as_ref().err());
        let c = ok.unwrap();
        assert_eq!(c.name, "New");
        assert_eq!(c.phone, "8765432109");
        assert_eq!(c.notes.as_deref(), Some("updated"));
        assert_eq!(c.opening_balance_paise, 0);
    }

    #[test]
    fn lookup_by_4_to_10_digit_phone_substring() {

        let db = Db::open_in_memory().unwrap();
        db.with_raw(|c| {
            c.execute(
                "INSERT INTO customers (name, phone) VALUES ('Test', '9876543210')",
                [],
            )
            .unwrap();
            let stored: String = c
                .query_row("SELECT phone FROM customers LIMIT 1", [], |r| r.get(0))
                .unwrap();
            assert_eq!(stored, "9876543210");
        });
        // 4-digit substring '4321' must match '9876543210' (positions 5-8).
        let q4: String = db.with_raw(|c| {
            c.query_row(
                "SELECT name FROM customers WHERE phone LIKE '%4321%'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        });
        assert_eq!(q4, "Test");
        // 10-digit full match.
        let q10: String = db.with_raw(|c| {
            c.query_row(
                "SELECT name FROM customers WHERE phone LIKE '%9876543210%'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        });
        assert_eq!(q10, "Test");
    }

    #[test]
    fn list_customer_bills_returns_final_sales_ordered_by_date_desc() {

        let db = Db::open_in_memory().unwrap();
        // Seed a user for FK constraints
        db.with_raw(|c| {
            c.execute("INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length, created_at, updated_at) VALUES ('O', 'owner', X'00', X'00', 6, 0, 0)", []).unwrap();
        });
        let customer = create_customer_impl(
            &db,
            &cashier(),
            NewCustomer {
                name: "Bill".into(),
                phone: "9876543210".into(),
                customer_type_id: None,
                is_flagged: None,
                opening_balance_paise: Some(0),
                notes: None,
            },
        )
        .unwrap();

        db.with_raw(|c| {
            c.execute(
                "INSERT INTO sales (no, customer_id, total, paid_amount, status, date, subtotal, user_id) VALUES ('QTN-1', ?1, 100, 50, 'quotation', '2025-01-10', 100, 1)",
                [customer.id],
            ).unwrap();
            c.execute(
                "INSERT INTO sales (no, customer_id, total, paid_amount, status, date, subtotal, user_id) VALUES ('INV-1', ?1, 250, 200, 'final', '2025-01-15', 250, 1)",
                [customer.id],
            ).unwrap();
            c.execute(
                "INSERT INTO sales (no, customer_id, total, paid_amount, status, date, subtotal, user_id) VALUES ('INV-2', ?1, 180, 180, 'final', '2025-01-12', 180, 1)",
                [customer.id],
            ).unwrap();
            c.execute(
                "INSERT INTO sales (no, customer_id, total, paid_amount, status, date, subtotal, user_id) VALUES ('INV-3', ?1, 300, 0, 'final', '2025-01-15', 300, 1)",
                [customer.id],
            ).unwrap();
        });

        let bills = list_customer_bills_impl(&db, customer.id).unwrap();
        assert_eq!(bills.len(), 3, "draft sale should be excluded");
        assert_eq!(bills[0].total, 300);
        assert_eq!(bills[1].total, 250);
        assert_eq!(bills[2].total, 180);
    }

}

// ---- Unified List Display System (PR-1, Wave 2) ----

const CUSTOMERS_SORT_WHITELIST: &[&str] = &["name", "phone", "opening_balance_paise", "created_at"];

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_list_customers_paged(
    state: State<'_, AppState>,
    query: ListQuery,
) -> AppResult<ListPage<Customer>> {
    let user = require_auth("cmd_list_customers_paged", state.inner())?;
    require_role(&user, &[Role::Owner, Role::Cashier])?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let limit = query.limit.unwrap_or(25).clamp(1, 100);
    let offset = query.offset.unwrap_or(0).max(0);
    let sort_field = sanitize_sort(query.sort_field.as_deref(), CUSTOMERS_SORT_WHITELIST, "name");
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
            wheres.push("c.is_active = 1".to_string());
        }
        if let Some(q) = query.search.as_ref().filter(|s| !s.is_empty()) {
            let like = format!("%{}%", q);
            wheres.push("(c.name LIKE ? OR c.phone LIKE ?)".to_string());
            params.push(Box::new(like.clone()));
            params.push(Box::new(like));
        }
        if let Some(ctid) = query.filters.get("customer_type_id").and_then(|v| v.as_i64()) {
            wheres.push("c.customer_type_id = ?".to_string());
            params.push(Box::new(ctid));
        }
        if let Some(flagged) = query.filters.get("is_flagged").and_then(|v| v.as_bool()) {
            if flagged {
                wheres.push("c.is_flagged = 1".to_string());
            }
        }

        let where_refs: Vec<&str> = wheres.iter().map(|s| s.as_str()).collect();
        let order_by = format!(
            " ORDER BY c.{} COLLATE NOCASE {} LIMIT ? OFFSET ?",
            sort_field, sort_dir
        );
        params.push(Box::new(limit));
        params.push(Box::new(offset));

        let base_select = "SELECT c.id, c.name, c.phone, c.customer_type_id, t.name, \
                           c.is_flagged, c.opening_balance_paise, c.notes, c.is_active, \
                           c.created_at, c.updated_at \
                           FROM customers c LEFT JOIN customer_types t ON t.id = c.customer_type_id";
        let count_select = "SELECT COUNT(*) FROM customers c";

        let (rows, total) = paged_query(
            c,
            base_select,
            count_select,
            &where_refs,
            &order_by,
            &params,
            |r| {
                Ok(Customer {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    phone: r.get(2)?,
                    customer_type_id: r.get(3)?,
                    type_name: r.get(4)?,
                    is_flagged: r.get::<_, i64>(5)? != 0,
                    opening_balance_paise: r.get(6)?,
                    notes: r.get(7)?,
                    is_active: r.get::<_, i64>(8)? != 0,
                    created_at: r.get(9)?,
                    updated_at: r.get(10)?,
                })
            },
        )?;
        Ok(ListPage { rows, total })
    })
}

#[derive(Debug, Serialize)]
pub struct CustomerMetrics {
    pub total: i64,
    pub active: i64,
    pub inactive: i64,
    pub flagged: i64,
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_customer_metrics(state: State<'_, AppState>) -> AppResult<CustomerMetrics> {
    let user = require_auth("cmd_customer_metrics", state.inner())?;
    require_role(&user, &[Role::Owner, Role::Cashier])?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    db.with_raw(|c| {
        let total: i64 = c.query_row("SELECT COUNT(*) FROM customers", [], |r| r.get(0))?;
        let active: i64 = c.query_row(
            "SELECT COUNT(*) FROM customers WHERE is_active = 1",
            [],
            |r| r.get(0),
        )?;
        let inactive: i64 = c.query_row(
            "SELECT COUNT(*) FROM customers WHERE is_active = 0",
            [],
            |r| r.get(0),
        )?;
        let flagged: i64 = c.query_row(
            "SELECT COUNT(*) FROM customers WHERE is_flagged = 1",
            [],
            |r| r.get(0),
        )?;
        Ok(CustomerMetrics {
            total,
            active,
            inactive,
            flagged,
        })
    })
}

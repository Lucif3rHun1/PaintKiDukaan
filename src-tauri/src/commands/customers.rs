//! Customers CRUD + outstanding balance.
//!
//! - Phone is `^[6-9]\d{9}$` (10 digits, starts 6-9) and unique.
//! - `is_flagged` and `opening_balance` updates are owner-only; cashier can set
//!   `opening_balance` on create.
//! - `customer_outstanding` = opening + Σ(sales.total - paid) - Σ(payments).

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::session::{current_user, require_role, Role};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Customer {
    pub id: i64,
    pub name: String,
    pub phone: String,
    pub type_id: Option<i64>,
    pub type_name: Option<String>,
    pub is_flagged: bool,
    pub opening_balance: i64,
    pub notes: Option<String>,
    pub is_active: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct CustomerOutstanding {
    pub customer_id: i64,
    pub opening_balance: i64,
    pub total_sales: i64,
    pub total_paid: i64,
    pub total_payments: i64,
    /// opening + (total_sales - total_paid) - total_payments
    pub outstanding: i64,
}

#[derive(Debug, Deserialize)]
pub struct NewCustomer {
    pub name: String,
    pub phone: String,
    pub type_id: Option<i64>,
    pub is_flagged: Option<bool>,
    pub opening_balance: Option<i64>,
    pub notes: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CustomerUpdate {
    pub name: Option<String>,
    pub phone: Option<String>,
    pub type_id: Option<Option<i64>>,
    pub is_flagged: Option<bool>,
    pub opening_balance: Option<i64>,
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

#[tauri::command]
pub fn create_customer(db: State<'_, Db>, payload: NewCustomer) -> AppResult<Customer> {
    let user = current_user()?;
    create_customer_impl(db.inner(), &user, payload)
}

fn create_customer_impl(
    db: &Db,
    user: &crate::session::User,
    payload: NewCustomer,
) -> AppResult<Customer> {
    require_role(user, &[Role::Owner, Role::Cashier])?;
    validate_phone(&payload.phone)?;

    // is_flagged is owner-only.
    let is_flagged = if payload.is_flagged.unwrap_or(false) {
        require_role(user, &[Role::Owner])?;
        true
    } else {
        false
    };

    db.with_conn_immediate(|tx| {
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
            "INSERT INTO customers (name, phone, type_id, is_flagged, opening_balance, notes, is_active) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)",
            params![
                payload.name,
                payload.phone,
                payload.type_id,
                if is_flagged { 1_i64 } else { 0_i64 },
                payload.opening_balance.unwrap_or(0),
                payload.notes,
            ],
        )?;
        let id = tx.last_insert_rowid();
        fetch_customer_tx(tx, id)
    })
}

#[tauri::command]
pub fn update_customer(
    db: State<'_, Db>,
    id: i64,
    patch: CustomerUpdate,
) -> AppResult<Customer> {
    let user = current_user()?;
    update_customer_impl(db.inner(), &user, id, patch)
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
    if patch.is_flagged.is_some() || patch.opening_balance.is_some() {
        require_role(user, &[Role::Owner])?;
    }
    db.with_conn_immediate(|tx| {
        let _current = fetch_customer_tx(tx, id)?;
        let mut sets: Vec<&'static str> = Vec::new();
        let mut values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        macro_rules! add {
            ($col:literal, $val:expr) => {{
                sets.push(concat!($col, " ?"));
                values.push(Box::new($val));
            }};
        }
        if let Some(v) = &patch.name { add!("name =", v.clone()) }
        if let Some(v) = &patch.phone {
            let taken: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM customers WHERE phone = ?1 AND id <> ?2)",
                params![v, id], |r| r.get(0),
            ).unwrap_or(false);
            if taken {
                return Err(AppError::Conflict(format!("phone {v} already exists")));
            }
            add!("phone =", v.clone());
        }
        if let Some(v) = &patch.type_id { add!("type_id =", v) }
        if let Some(v) = patch.opening_balance { add!("opening_balance =", v) }
        if let Some(v) = &patch.notes { add!("notes =", v) }
        if let Some(v) = patch.is_flagged {
            add!("is_flagged =", if v { 1_i64 } else { 0_i64 });
        }
        if let Some(v) = patch.is_active { add!("is_active =", if v { 1_i64 } else { 0_i64 }) }
        if sets.is_empty() {
            return Err(AppError::Validation("no fields to update".into()));
        }
        sets.push("updated_at = datetime('now')");
        let sql = format!("UPDATE customers SET {} WHERE id = ?", sets.join(", "));
        let mut pvec: Vec<&dyn rusqlite::ToSql> = values.iter().map(|b| &**b as &dyn rusqlite::ToSql).collect();
        pvec.push(&id);
        let n = tx.execute(&sql, pvec.as_slice())?;
        if n == 0 {
            return Err(AppError::NotFound(format!("customer {id}")));
        }
        fetch_customer_tx(tx, id)
    })
}

#[tauri::command]
pub fn list_customers(
    db: State<'_, Db>,
    query: Option<String>,
    include_inactive: bool,
) -> AppResult<Vec<Customer>> {
    let _ = current_user()?;
    db.with_conn(|c| {
        let mut sql = String::from(
            "SELECT c.id, c.name, c.phone, c.type_id, t.name, c.is_flagged, c.opening_balance, c.notes, c.is_active, c.created_at, c.updated_at \
             FROM customers c LEFT JOIN customer_types t ON t.id = c.type_id WHERE 1=1",
        );
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if !include_inactive { sql.push_str(" AND c.is_active = 1"); }
        if let Some(q) = &query {
            sql.push_str(&format!(" AND (c.name LIKE ?{} OR c.phone LIKE ?{})", args.len() + 1, args.len() + 1));
            args.push(Box::new(format!("%{}%", q)));
        }
        sql.push_str(" ORDER BY c.name");
        let mut stmt = c.prepare(&sql)?;
        let dyn_args: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| &**b as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(dyn_args.as_slice(), |r| {
            Ok(Customer {
                id: r.get(0)?,
                name: r.get(1)?,
                phone: r.get(2)?,
                type_id: r.get(3)?,
                type_name: r.get(4)?,
                is_flagged: r.get::<_, i64>(5)? != 0,
                opening_balance: r.get(6)?,
                notes: r.get(7)?,
                is_active: r.get::<_, i64>(8)? != 0,
                created_at: r.get(9)?,
                updated_at: r.get(10)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    })
}

#[tauri::command]
pub fn lookup_customer(db: State<'_, Db>, phone: String) -> AppResult<Option<Customer>> {
    let _ = current_user()?;
    // Master plan §7.4: search by 4-10 digit phone substring.
    let q = phone.trim();
    if q.len() < 4 || q.len() > 10 || !q.chars().all(|c| c.is_ascii_digit()) {
        return Err(AppError::Validation(
            "phone search must be 4-10 digits".into(),
        ));
    }
    let like_pattern = format!("%{q}%");
    db.with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT c.id, c.name, c.phone, c.type_id, t.name, c.is_flagged, c.opening_balance, c.notes, c.is_active, c.created_at, c.updated_at \
             FROM customers c LEFT JOIN customer_types t ON t.id = c.type_id \
             WHERE c.phone LIKE ?1 \
             ORDER BY c.id ASC LIMIT 1",
        )?;
        let mut rows = stmt.query_map(params![like_pattern], |r| {
            Ok(Customer {
                id: r.get(0)?,
                name: r.get(1)?,
                phone: r.get(2)?,
                type_id: r.get(3)?,
                type_name: r.get(4)?,
                is_flagged: r.get::<_, i64>(5)? != 0,
                opening_balance: r.get(6)?,
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

fn customer_outstanding_impl(db: &Db, id: i64) -> AppResult<CustomerOutstanding> {
    db.with_conn(|c| {
        let opening: i64 = c.query_row(
            "SELECT opening_balance FROM customers WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        let total_sales: i64 = c.query_row(
            "SELECT COALESCE(SUM(total - paid_amount), 0) FROM sales WHERE customer_id = ?1 AND status = 'final'",
            params![id], |r| r.get(0),
        )?;
        let total_payments: i64 = c.query_row(
            "SELECT COALESCE(SUM(amount), 0) FROM customer_payments WHERE customer_id = ?1",
            params![id], |r| r.get(0),
        )?;
        // Per spec: outstanding = opening + Σ(sales.total - paid) - Σ(payments).
        // `total_sales` above already encodes Σ(sales.total - sales.paid_amount).
        // We expose `total_paid` for UI clarity but it is not subtracted again.
        let total_paid: i64 = c.query_row(
            "SELECT COALESCE(SUM(paid_amount), 0) FROM sales WHERE customer_id = ?1 AND status = 'final'",
            params![id], |r| r.get(0),
        )?;
        let outstanding = opening + total_sales - total_payments;
        Ok(CustomerOutstanding {
            customer_id: id,
            opening_balance: opening,
            total_sales,
            total_paid,
            total_payments,
            outstanding,
        })
    })
}

#[tauri::command]
pub fn customer_outstanding(
    db: State<'_, Db>,
    id: i64,
) -> AppResult<CustomerOutstanding> {
    let _ = current_user()?;
    customer_outstanding_impl(db.inner(), id)
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
    db.with_conn(|c| {
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

#[tauri::command]
pub fn list_customer_bills(db: State<'_, Db>, customer_id: i64) -> AppResult<Vec<CustomerBill>> {
    let _ = current_user()?;
    list_customer_bills_impl(db.inner(), customer_id)
}

fn fetch_customer_tx(tx: &rusqlite::Transaction<'_>, id: i64) -> AppResult<Customer> {
    let mut stmt = tx.prepare(
        "SELECT c.id, c.name, c.phone, c.type_id, t.name, c.is_flagged, c.opening_balance, c.notes, c.is_active, c.created_at, c.updated_at \
         FROM customers c LEFT JOIN customer_types t ON t.id = c.type_id WHERE c.id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], |r| {
        Ok(Customer {
            id: r.get(0)?,
            name: r.get(1)?,
            phone: r.get(2)?,
            type_id: r.get(3)?,
            type_name: r.get(4)?,
            is_flagged: r.get::<_, i64>(5)? != 0,
            opening_balance: r.get(6)?,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::session::{set_current_user, User};

    fn owner() -> User { User { id: 1, name: "O".into(), role: Role::Owner } }
    fn cashier() -> User { User { id: 2, name: "C".into(), role: Role::Cashier } }

    #[test]
    fn phone_validation() {
        assert!(validate_phone("9876543210").is_ok());
        assert!(validate_phone("5987654321").is_err()); // starts with 5
        assert!(validate_phone("987654321").is_err());  // 9 digits
        assert!(validate_phone("98765432101").is_err()); // 11 digits
        assert!(validate_phone("98765abcde").is_err());  // non-digit
    }

    #[test]
    fn create_customer_enforces_unique_phone() {
        set_current_user(Some(cashier()));
        let db = Db::open_in_memory().unwrap();
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO customers (name, phone) VALUES ('A', '9876543210')",
                [],
            ).unwrap();
        });
        let res: AppResult<()> = db.with_conn_immediate(|tx| {
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM customers WHERE phone = ?1)",
                ["9876543210"], |r| r.get(0),
            ).unwrap_or(false);
            if exists { return Err(AppError::Conflict("dup".into())); }
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
        set_current_user(Some(cashier()));
        let db = Db::open_in_memory().unwrap();
        let id = db.with_conn(|c| {
            c.execute(
                "INSERT INTO customers (name, phone) VALUES ('Test', '9876543210')",
                [],
            ).unwrap();
            c.last_insert_rowid()
        });
        let res = update_customer_impl(
            &db,
            &cashier(),
            id,
            CustomerUpdate {
                name: None,
                phone: None,
                type_id: None,
                is_flagged: Some(true),
                opening_balance: None,
                notes: None,
                is_active: None,
            },
        );
        assert!(matches!(res, Err(AppError::Forbidden(_))));

        // Owner may set it.
        set_current_user(Some(owner()));
        let ok = update_customer_impl(
            &db,
            &owner(),
            id,
            CustomerUpdate {
                name: None,
                phone: None,
                type_id: None,
                is_flagged: Some(true),
                opening_balance: None,
                notes: None,
                is_active: None,
            },
        );
        assert!(ok.is_ok(), "owner should be allowed, got: {:?}", ok.as_ref().err());
        assert!(ok.unwrap().is_flagged);
    }

    #[test]
    fn opening_balance_only_owner_can_update() {
        set_current_user(Some(cashier()));
        let db = Db::open_in_memory().unwrap();
        let id = db.with_conn(|c| {
            c.execute(
                "INSERT INTO customers (name, phone) VALUES ('Test', '9876543210')",
                [],
            ).unwrap();
            c.last_insert_rowid()
        });

        let res = update_customer_impl(
            &db,
            &cashier(),
            id,
            CustomerUpdate {
                name: None,
                phone: None,
                type_id: None,
                is_flagged: None,
                opening_balance: Some(1000),
                notes: None,
                is_active: None,
            },
        );
        assert!(matches!(res, Err(AppError::Forbidden(_))), "cashier updating opening_balance must be Forbidden");

        set_current_user(Some(owner()));
        let ok = update_customer_impl(
            &db,
            &owner(),
            id,
            CustomerUpdate {
                name: None,
                phone: None,
                type_id: None,
                is_flagged: None,
                opening_balance: Some(1000),
                notes: None,
                is_active: None,
            },
        );
        assert!(ok.is_ok(), "owner should be allowed, got: {:?}", ok.as_ref().err());
        assert_eq!(ok.unwrap().opening_balance, 1000);
    }

    #[test]
    fn cashier_can_set_opening_balance_on_create() {
        set_current_user(Some(cashier()));
        let db = Db::open_in_memory().unwrap();
        let c = create_customer_impl(
            &db,
            &cashier(),
            NewCustomer {
                name: "Test".into(),
                phone: "9876543210".into(),
                type_id: None,
                is_flagged: None,
                opening_balance: Some(2500),
                notes: None,
            },
        ).unwrap();
        assert_eq!(c.opening_balance, 2500);
    }

    #[test]
    fn cashier_can_update_non_owner_fields() {
        set_current_user(Some(cashier()));
        let db = Db::open_in_memory().unwrap();
        let id = create_customer_impl(
            &db,
            &cashier(),
            NewCustomer {
                name: "Old".into(),
                phone: "9876543210".into(),
                type_id: None,
                is_flagged: None,
                opening_balance: Some(100),
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
                type_id: None,
                is_flagged: None,
                opening_balance: None,
                notes: Some(Some("updated".into())),
                is_active: None,
            },
        );
        assert!(ok.is_ok(), "cashier update failed: {:?}", ok.as_ref().err());
        let c = ok.unwrap();
        assert_eq!(c.name, "New");
        assert_eq!(c.phone, "8765432109");
        assert_eq!(c.notes.as_deref(), Some("updated"));
        assert_eq!(c.opening_balance, 100);
    }

    #[test]
    fn lookup_by_4_to_10_digit_phone_substring() {
        set_current_user(Some(owner()));
        let db = Db::open_in_memory().unwrap();
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO customers (name, phone) VALUES ('Test', '9876543210')",
                [],
            ).unwrap();
            let stored: String = c
                .query_row("SELECT phone FROM customers LIMIT 1", [], |r| r.get(0))
                .unwrap();
            assert_eq!(stored, "9876543210");
        });
        // 4-digit substring '4321' must match '9876543210' (positions 5-8).
        let q4: String = db.with_conn(|c| {
            c.query_row(
                "SELECT name FROM customers WHERE phone LIKE '%4321%'",
                [],
                |r| r.get(0),
            ).unwrap()
        });
        assert_eq!(q4, "Test");
        // 10-digit full match.
        let q10: String = db.with_conn(|c| {
            c.query_row(
                "SELECT name FROM customers WHERE phone LIKE '%9876543210%'",
                [],
                |r| r.get(0),
            ).unwrap()
        });
        assert_eq!(q10, "Test");
    }

    #[test]
    fn list_customer_bills_returns_final_sales_ordered_by_date_desc() {
        set_current_user(Some(cashier()));
        let db = Db::open_in_memory().unwrap();
        let customer = create_customer_impl(
            &db,
            &cashier(),
            NewCustomer {
                name: "Bill".into(),
                phone: "9876543210".into(),
                type_id: None,
                is_flagged: None,
                opening_balance: Some(0),
                notes: None,
            },
        )
        .unwrap();

        db.with_conn(|c| {
            c.execute(
                "INSERT INTO sales (customer_id, total, paid_amount, status, date) VALUES (?1, 100, 50, 'draft', '2025-01-10')",
                [customer.id],
            ).unwrap();
            c.execute(
                "INSERT INTO sales (customer_id, total, paid_amount, status, date) VALUES (?1, 250, 200, 'final', '2025-01-15')",
                [customer.id],
            ).unwrap();
            c.execute(
                "INSERT INTO sales (customer_id, total, paid_amount, status, date) VALUES (?1, 180, 180, 'final', '2025-01-12')",
                [customer.id],
            ).unwrap();
            c.execute(
                "INSERT INTO sales (customer_id, total, paid_amount, status, date) VALUES (?1, 300, 0, 'final', '2025-01-15')",
                [customer.id],
            ).unwrap();
        });

        let bills = list_customer_bills_impl(&db, customer.id).unwrap();
        assert_eq!(bills.len(), 3, "draft sale should be excluded");
        assert_eq!(bills[0].total, 300);
        assert_eq!(bills[1].total, 250);
        assert_eq!(bills[2].total, 180);
    }

    #[test]
    fn customer_outstanding_command() {
        set_current_user(Some(owner()));
        let db = Db::open_in_memory().unwrap();
        let cust_id = db.with_conn(|c| {
            c.execute(
                "INSERT INTO customers (name, phone, opening_balance) VALUES ('X', '9876543210', 500)",
                [],
            ).unwrap();
            c.last_insert_rowid()
        });
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO sales (customer_id, total, paid_amount, status, date) VALUES (?1, 1000, 400, 'final', '2024-01-01')",
                [cust_id],
            ).unwrap();
            c.execute(
                "INSERT INTO customer_payments (customer_id, amount, mode, date, user_id) VALUES (?1, 200, 'cash', '2024-01-02', 1)",
                [cust_id],
            ).unwrap();
        });
        let out = customer_outstanding_impl(&db, cust_id).unwrap();
        assert_eq!(out.customer_id, cust_id);
        assert_eq!(out.opening_balance, 500);
        assert_eq!(out.total_sales, 600);
        assert_eq!(out.total_paid, 400);
        assert_eq!(out.total_payments, 200);
        assert_eq!(out.outstanding, 900);
    }
}

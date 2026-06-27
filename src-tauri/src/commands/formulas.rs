//! Formulas — custom shade mixes sold on demand. First-class entity (ADR-011).
//!
//! Endpoints:
//!   - `cmd_list_formulas`     — list page with active/inactive filter, search
//!   - `cmd_get_formula`       — details by id
//!   - `cmd_create_formula`    — create with id_code (immutable), name?, with_base, price
//!   - `cmd_update_formula`    — edit name, with_base, price (id_code immutable)
//!   - `cmd_deactivate_formula` — soft-delete via is_active=0 (ADR-014)
//!   - `cmd_list_formula_sales` — history sub-section of FormulaDetailsPage (ADR-016)

use rusqlite::params;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::commands::auth::AppState;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::security::ipc_auth;

#[derive(Debug, Clone, Serialize)]
pub struct Formula {
    pub id: i64,
    pub id_code: String,
    pub name: Option<String>,
    pub with_base: bool,
    pub base_item_id: Option<i64>,
    pub base_item_name: Option<String>,
    pub retail_price_paise: i64,
    pub is_active: bool,
    pub created_at: String,
    pub created_by_user_id: Option<i64>,
    pub sales_count: i64,
    pub last_sold_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct FormulaFilter {
    /// `None` returns active + inactive. `Some(true)` = only active. `Some(false)` = only inactive.
    pub active: Option<bool>,
    /// LIKE on id_code (prefix) or name. Empty / missing = no text filter.
    pub query: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewFormula {
    pub id_code: String,
    pub name: Option<String>,
    pub with_base: bool,
    pub base_item_id: Option<i64>,
    pub retail_price_paise: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateFormula {
    pub id: i64,
    pub name: Option<String>,
    pub with_base: bool,
    pub base_item_id: Option<i64>,
    pub retail_price_paise: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct FormulaSaleRow {
    pub sale_id: i64,
    pub sale_no: String,
    pub sale_date: String,
    pub sale_kind: String,
    pub customer_id: Option<i64>,
    pub customer_name: Option<String>,
    pub qty: i64,
    pub price: i64,
    pub line_total: i64,
    pub line_discount: i64,
    pub shade_note: Option<String>,
    pub sold_at: String,
}

// -----------------------------------------------------------------------------
// Validation helpers (pure).
// -----------------------------------------------------------------------------

fn validate_id_code(s: &str) -> AppResult<()> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("id_code is required".into()));
    }
    if trimmed.len() > 32 {
        return Err(AppError::Validation(
            "id_code must be 32 chars or fewer".into(),
        ));
    }
    Ok(())
}

fn validate_price(p: i64) -> AppResult<()> {
    if p < 0 {
        return Err(AppError::Validation(
            "retail_price_paise must be >= 0".into(),
        ));
    }
    Ok(())
}

// -----------------------------------------------------------------------------
// Reads.
// -----------------------------------------------------------------------------

fn row_to_formula(r: &rusqlite::Row<'_>) -> rusqlite::Result<Formula> {
    Ok(Formula {
        id: r.get(0)?,
        id_code: r.get(1)?,
        name: r.get(2)?,
        with_base: r.get::<_, i64>(3)? != 0,
        retail_price_paise: r.get(4)?,
        is_active: r.get::<_, i64>(5)? != 0,
        created_at: r.get(6)?,
        created_by_user_id: r.get(7)?,
        sales_count: r.get(8)?,
        last_sold_at: r.get(9)?,
        base_item_id: r.get(10)?,
        base_item_name: r.get(11)?,
    })
}

pub fn list(db: &Db, filter: FormulaFilter) -> AppResult<Vec<Formula>> {
    let mut sql = String::from(
        "SELECT f.id, f.id_code, f.name, f.with_base, f.retail_price_paise, f.is_active, \
                f.created_at, f.created_by, \
                (SELECT COUNT(*) FROM sale_items si JOIN sales s ON s.id = si.sale_id \
                  WHERE si.formula_id = f.id AND s.status = 'final') AS sales_count, \
                (SELECT MAX(s.created_at) FROM sale_items si JOIN sales s ON s.id = si.sale_id \
                  WHERE si.formula_id = f.id AND s.status = 'final') AS last_sold_at, \
                f.base_item_id, bi.name AS base_item_name \
         FROM formulas f \
         LEFT JOIN items bi ON bi.id = f.base_item_id \
         WHERE 1=1",
    );
    let mut bound: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(active) = filter.active {
        sql.push_str(&format!(" AND f.is_active = ?{}", bound.len() + 1));
        bound.push(Box::new(active as i64));
    }
    if let Some(q) = filter.query.as_deref() {
        let q = q.trim();
        if !q.is_empty() {
            sql.push_str(&format!(
                " AND (f.id_code LIKE ?{} || '%' OR f.name LIKE '%' || ?{} || '%')",
                bound.len() + 1,
                bound.len() + 1,
            ));
            bound.push(Box::new(q.to_string()));
        }
    }
    sql.push_str(" ORDER BY f.is_active DESC, f.id_code ASC");
    let dyn_args: Vec<&dyn rusqlite::ToSql> =
        bound.iter().map(|b| &**b as &dyn rusqlite::ToSql).collect();
    db.with_raw(|c| {
        let mut stmt = c.prepare(&sql)?;
        let rows = stmt.query_map(dyn_args.as_slice(), row_to_formula)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
}

pub fn get_by_id(db: &Db, id: i64) -> AppResult<Option<Formula>> {
    db.with_raw(|c| {
        let row = c
            .query_row(
                "SELECT f.id, f.id_code, f.name, f.with_base, f.retail_price_paise, f.is_active, \
                        f.created_at, f.created_by, \
                        (SELECT COUNT(*) FROM sale_items si JOIN sales s ON s.id = si.sale_id \
                          WHERE si.formula_id = f.id AND s.status = 'final') AS sales_count, \
                        (SELECT MAX(s.created_at) FROM sale_items si JOIN sales s ON s.id = si.sale_id \
                          WHERE si.formula_id = f.id AND s.status = 'final') AS last_sold_at, \
                        f.base_item_id, bi.name AS base_item_name \
                 FROM formulas f \
                 LEFT JOIN items bi ON bi.id = f.base_item_id \
                 WHERE f.id = ?1",
                params![id],
                row_to_formula,
            )
            .optional()?;
        Ok(row)
    })
}

/// History sub-section (ADR-016). `from_date` / `to_date` are `YYYY-MM-DD` strings;
/// `None` means unbounded on that side. `query` is `LIKE` on invoice number or
/// customer name.
pub fn list_sales(
    db: &Db,
    formula_id: i64,
    query: Option<&str>,
    from_date: Option<&str>,
    to_date: Option<&str>,
    limit: i64,
) -> AppResult<Vec<FormulaSaleRow>> {
    let mut sql = String::from(
        "SELECT s.id, s.no, s.date, s.status, s.customer_id, c.name, \
                si.qty, si.price, (si.qty * si.price - si.line_discount) AS line_total, \
                si.line_discount, si.shade_note, s.created_at \
         FROM sale_items si \
         JOIN sales s ON s.id = si.sale_id \
         LEFT JOIN customers c ON c.id = s.customer_id \
         WHERE si.formula_id = ?1 AND s.status = 'final'",
    );
    let mut bound: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(formula_id)];
    if let Some(q) = query.map(str::trim).filter(|q| !q.is_empty()) {
        sql.push_str(&format!(
            " AND (s.no LIKE '%' || ?{} || '%' OR c.name LIKE '%' || ?{} || '%')",
            bound.len() + 1,
            bound.len() + 1,
        ));
        bound.push(Box::new(q.to_string()));
    }
    if let Some(d) = from_date {
        sql.push_str(&format!(" AND s.date >= ?{}", bound.len() + 1));
        bound.push(Box::new(d.to_string()));
    }
    if let Some(d) = to_date {
        sql.push_str(&format!(" AND s.date <= ?{}", bound.len() + 1));
        bound.push(Box::new(d.to_string()));
    }
    sql.push_str(&format!(
        " ORDER BY s.created_at DESC, s.id DESC LIMIT ?{}",
        bound.len() + 1
    ));
    bound.push(Box::new(limit));
    let dyn_args: Vec<&dyn rusqlite::ToSql> =
        bound.iter().map(|b| &**b as &dyn rusqlite::ToSql).collect();
    db.with_raw(|c| {
        let mut stmt = c.prepare(&sql)?;
        let rows = stmt.query_map(dyn_args.as_slice(), |r| {
            Ok(FormulaSaleRow {
                sale_id: r.get(0)?,
                sale_no: r.get(1)?,
                sale_date: r.get(2)?,
                sale_kind: r.get(3)?,
                customer_id: r.get(4)?,
                customer_name: r.get(5)?,
                qty: r.get(6)?,
                price: r.get(7)?,
                line_total: r.get(8)?,
                line_discount: r.get(9)?,
                shade_note: r.get(10)?,
                sold_at: r.get(11)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
}

// -----------------------------------------------------------------------------
// Writes.
// -----------------------------------------------------------------------------

pub fn create(db: &Db, user_id: i64, new: NewFormula) -> AppResult<i64> {
    validate_id_code(&new.id_code)?;
    validate_price(new.retail_price_paise)?;
    let id_code = new.id_code.trim().to_string();
    let name = new.name.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let with_base = new.with_base as i64;
    // Validate: with_base requires base_item_id; without_base forces None.
    let base_item_id: Option<i64> = if new.with_base {
        Some(new.base_item_id.ok_or_else(|| {
            AppError::Validation("with_base requires base_item_id".into())
        })?)
    } else {
        None // force None when without base
    };
    db.with_conn_immediate(|c| -> Result<i64, AppError> {
        if let Some(_existing) = c
            .query_row(
                "SELECT id FROM formulas WHERE id_code = ?1",
                params![id_code],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
        {
            return Err(AppError::Conflict(format!(
                "formula id_code '{id_code}' already exists"
            )));
        }
        let id: i64 = c.query_row(
            "INSERT INTO formulas (id_code, name, with_base, base_item_id, retail_price_paise, created_by)\
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id",
            params![id_code, name, with_base, base_item_id, new.retail_price_paise, user_id],
            |r| r.get(0),
        )?;
        Ok(id)
    })
}

pub fn update(db: &Db, _user_id: i64, upd: UpdateFormula) -> AppResult<()> {
    validate_price(upd.retail_price_paise)?;
    let name = upd.name.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let with_base = upd.with_base as i64;
    let base_item_id: Option<i64> = if upd.with_base {
        Some(upd.base_item_id.ok_or_else(|| {
            AppError::Validation("with_base requires base_item_id".into())
        })?)
    } else {
        None
    };
    db.with_conn_immediate(|c| -> Result<(), AppError> {
        let changed = c.execute(
            "UPDATE formulas SET name = ?1, with_base = ?2, base_item_id = ?3, retail_price_paise = ?4\
             WHERE id = ?5 AND is_active = 1",
            params![name, with_base, base_item_id, upd.retail_price_paise, upd.id],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound(format!(
                "formula {} not found or inactive",
                upd.id
            )));
        }
        Ok(())
    })
}

/// Soft-delete (ADR-014): flips `is_active` to 0. Hard delete is intentionally
/// not exposed — FK from `sale_items.formula_id` would orphan history.
pub fn deactivate(db: &Db, _user_id: i64, id: i64) -> AppResult<()> {
    db.with_conn_immediate(|c| -> Result<(), AppError> {
        let changed = c.execute(
            "UPDATE formulas SET is_active = 0 WHERE id = ?1 AND is_active = 1",
            params![id],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound(format!(
                "formula {id} not found or already inactive"
            )));
        }
        Ok(())
    })
}

// -----------------------------------------------------------------------------
// Tauri command surface.
// -----------------------------------------------------------------------------

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_list_formulas(
    state: tauri::State<'_, AppState>,
    filter: Option<FormulaFilter>,
) -> AppResult<Vec<Formula>> {
    ipc_auth::authorize_err("cmd_list_formulas", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    list(db, filter.unwrap_or_default())
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_get_formula(state: tauri::State<'_, AppState>, id: i64) -> AppResult<Option<Formula>> {
    ipc_auth::authorize_err("cmd_get_formula", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    get_by_id(db, id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_create_formula(
    state: tauri::State<'_, AppState>,
    payload: NewFormula,
) -> AppResult<i64> {
    ipc_auth::authorize_err("cmd_create_formula", state.inner())?;
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
    create(db, user.id, payload)
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_update_formula(
    state: tauri::State<'_, AppState>,
    payload: UpdateFormula,
) -> AppResult<()> {
    ipc_auth::authorize_err("cmd_update_formula", state.inner())?;
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
    update(db, user.id, payload)
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_deactivate_formula(state: tauri::State<'_, AppState>, id: i64) -> AppResult<()> {
    ipc_auth::authorize_err("cmd_deactivate_formula", state.inner())?;
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
    deactivate(db, user.id, id)
}

#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)]
pub fn cmd_list_formula_sales(
    state: tauri::State<'_, AppState>,
    formula_id: i64,
    query: Option<String>,
    from_date: Option<String>,
    to_date: Option<String>,
    limit: Option<i64>,
) -> AppResult<Vec<FormulaSaleRow>> {
    ipc_auth::authorize_err("cmd_list_formula_sales", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    list_sales(
        db,
        formula_id,
        query.as_deref(),
        from_date.as_deref(),
        to_date.as_deref(),
        limit.unwrap_or(200),
    )
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::customers;
    use crate::commands::sales;
    use crate::commands::sales::{CartLine, NewSale, PaymentSplit};

    fn open_db() -> Db {
        Db::open_in_memory().expect("in-memory db")
    }

    fn seed_user(db: &Db, id: i64, name: &str) {
        db.with_conn::<_, _, rusqlite::Error>(|c| {
            c.execute(
                "INSERT OR IGNORE INTO users (id, name, role, pin_salt, pin_verifier, pin_length, is_active, created_at, updated_at) \
                 VALUES (?1, ?2, 'owner', X'', X'', 6, 1, 0, 0)",
                rusqlite::params![id, name],
            )?;
            Ok(())
        })
        .expect("seed user");
    }

    fn seed_item(db: &Db, id: i64, sku: &str, name: &str) {
        db.with_conn::<_, _, rusqlite::Error>(|c| {
            c.execute(
                "INSERT OR IGNORE INTO units (id, code, label, dimension, is_active, created_at, updated_at) \
                 VALUES (1, 'pc', 'piece', 'count', 1, 0, 0)",
                [],
            )?;
            c.execute(
                "INSERT OR IGNORE INTO locations (id, name, is_default, is_active, created_at, updated_at) \
                 VALUES (1, 'Shop', 1, 1, 0, 0)",
                [],
            )?;
            c.execute(
                "INSERT INTO items (id, sku_code, name, unit_id, unit_code, unit_label, unit, sell_unit, \
                                    retail_price_paise, cost_paise, primary_location_id, min_qty, is_active, \
                                    created_at, updated_at) \
                 VALUES (?1, ?2, ?3, 1, 'pc', 'piece', 'pc', 'unit', 100, 50, 1, 0, 1, 0, 0)",
                rusqlite::params![id, sku, name],
            )?;
            Ok(())
        })
        .expect("seed item");
    }

    fn new_formula(code: &str, price: i64, with_base: bool) -> NewFormula {
        NewFormula {
            id_code: code.into(),
            name: Some("Rose Beige".into()),
            with_base,
            retail_price_paise: price,
        }
    }

    #[test]
    fn create_persists_and_round_trips() {
        let db = open_db();
        seed_user(&db, 1, "Owner");
        let id = create(&db, 1, new_formula("8827", 25000, true)).expect("create");
        let f = get_by_id(&db, id).expect("get").expect("row exists");
        assert_eq!(f.id_code, "8827");
        assert_eq!(f.name.as_deref(), Some("Rose Beige"));
        assert!(f.with_base);
        assert_eq!(f.retail_price_paise, 25000);
        assert!(f.is_active);
        assert_eq!(f.sales_count, 0);
        assert!(f.last_sold_at.is_none());
    }

    #[test]
    fn create_rejects_duplicate_id_code() {
        let db = open_db();
        seed_user(&db, 1, "Owner");
        create(&db, 1, new_formula("8827", 100, false)).expect("first create");
        let err = create(&db, 1, new_formula("8827", 200, false)).expect_err("dup");
        assert!(matches!(err, AppError::Conflict(_)), "got {err:?}");
    }

    #[test]
    fn create_rejects_empty_or_overlong_id_code() {
        let db = open_db();
        seed_user(&db, 1, "Owner");
        let long = "x".repeat(33);
        assert!(matches!(
            create(&db, 1, new_formula("", 0, false)),
            Err(AppError::Validation(_))
        ));
        assert!(matches!(
            create(&db, 1, new_formula(&long, 0, false)),
            Err(AppError::Validation(_))
        ));
    }

    #[test]
    fn create_rejects_negative_price() {
        let db = open_db();
        seed_user(&db, 1, "Owner");
        assert!(matches!(
            create(&db, 1, new_formula("8827", -1, false)),
            Err(AppError::Validation(_))
        ));
    }

    #[test]
    fn update_changes_fields_but_keeps_id_code() {
        let db = open_db();
        seed_user(&db, 1, "Owner");
        let id = create(&db, 1, new_formula("8827", 100, false)).expect("create");
        update(
            &db,
            1,
            UpdateFormula {
                id,
                name: Some("Updated Name".into()),
                with_base: true,
                retail_price_paise: 999,
            },
        )
        .expect("update");
        let f = get_by_id(&db, id).expect("get").expect("row exists");
        assert_eq!(f.id_code, "8827");
        assert_eq!(f.name.as_deref(), Some("Updated Name"));
        assert!(f.with_base);
        assert_eq!(f.retail_price_paise, 999);
    }

    #[test]
    fn update_on_inactive_returns_not_found() {
        let db = open_db();
        seed_user(&db, 1, "Owner");
        let id = create(&db, 1, new_formula("8827", 100, false)).expect("create");
        deactivate(&db, 1, id).expect("deactivate");
        let err = update(
            &db,
            1,
            UpdateFormula {
                id,
                name: None,
                with_base: false,
                retail_price_paise: 100,
            },
        )
        .expect_err("update on inactive");
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[test]
    fn deactivate_is_idempotent() {
        let db = open_db();
        seed_user(&db, 1, "Owner");
        let id = create(&db, 1, new_formula("8827", 100, false)).expect("create");
        deactivate(&db, 1, id).expect("first deactivate");
        let err = deactivate(&db, 1, id).expect_err("second deactivate");
        assert!(matches!(err, AppError::NotFound(_)));
        let f = get_by_id(&db, id).expect("get").expect("row");
        assert!(!f.is_active);
    }

    #[test]
    fn list_filter_active_and_query() {
        let db = open_db();
        seed_user(&db, 1, "Owner");
        let a = create(&db, 1, new_formula("8827", 100, false)).expect("a");
        let b = create(&db, 1, new_formula("1293", 200, true)).expect("b");
        create(&db, 1, new_formula("R-204", 300, false)).expect("c");
        deactivate(&db, 1, b).expect("deactivate b");

        let all = list(&db, FormulaFilter::default()).expect("list all");
        assert_eq!(all.len(), 3);

        let active_only = list(
            &db,
            FormulaFilter {
                active: Some(true),
                query: None,
            },
        )
        .expect("active only");
        assert_eq!(active_only.len(), 2);
        assert!(active_only.iter().all(|f| f.is_active));

        let search_8827 = list(
            &db,
            FormulaFilter {
                active: None,
                query: Some("8827".into()),
            },
        )
        .expect("search 8827");
        assert_eq!(search_8827.len(), 1);
        assert_eq!(search_8827[0].id, a);

        let search_name = list(
            &db,
            FormulaFilter {
                active: None,
                query: Some("rose".into()),
            },
        )
        .expect("search by name");
        assert_eq!(
            search_name.len(),
            3,
            "all three formulas share the name 'Rose Beige'"
        );
    }

    #[test]
    fn list_sales_returns_final_sales_only() {
        let db = open_db();
        seed_user(&db, 1, "Owner");
        seed_item(&db, 1, "SKU1", "Sample");
        let formula_id = create(&db, 1, new_formula("8827", 250, false)).expect("create");

        db.with_conn::<_, _, rusqlite::Error>(|c| {
            let qtn: i64 = c.query_row(
                "INSERT INTO sales (no, customer_id, date, status, subtotal, bill_discount, total, paid_amount, payment_modes_json, validity_days, user_id) \
                 VALUES ('QTN/2026-06-20/001', NULL, '2026-06-20', 'quotation', 250, 0, 250, 0, '[]', 7, 1) RETURNING id",
                [],
                |r| r.get(0),
            )?;
            c.execute(
                "INSERT INTO sale_items (sale_id, kind, item_id, formula_id, qty, price, unit_type, line_discount, shade_note, line_order) \
                 VALUES (?1, 'formula', NULL, ?2, 1, 250, 'unit', 0, NULL, 0)",
                rusqlite::params![qtn, formula_id],
            )?;
            let fin: i64 = c.query_row(
                "INSERT INTO sales (no, customer_id, date, status, subtotal, bill_discount, total, paid_amount, payment_modes_json, user_id) \
                 VALUES ('INV/2026-06-21/001', NULL, '2026-06-21', 'final', 250, 0, 250, 250, '[{\"mode\":\"cash\",\"amount\":250}]', 1) RETURNING id",
                [],
                |r| r.get(0),
            )?;
            c.execute(
                "INSERT INTO sale_items (sale_id, kind, item_id, formula_id, qty, price, unit_type, line_discount, shade_note, line_order) \
                 VALUES (?1, 'formula', NULL, ?2, 1, 250, 'unit', 0, NULL, 0)",
                rusqlite::params![fin, formula_id],
            )?;
            Ok(())
        })
        .expect("seed sales");

        let rows = list_sales(&db, formula_id, None, None, None, 100).expect("list sales");
        assert_eq!(
            rows.len(),
            1,
            "quotation must not appear in formula history"
        );
        assert_eq!(rows[0].sale_kind, "final");
        assert_eq!(rows[0].price, 250);
        assert_eq!(rows[0].line_total, 250);

        let from_2026_06_21 = list_sales(&db, formula_id, None, Some("2026-06-21"), None, 100)
            .expect("from date filter");
        assert_eq!(from_2026_06_21.len(), 1);
        let from_2026_06_22 = list_sales(&db, formula_id, None, Some("2026-06-22"), None, 100)
            .expect("from date filter excludes");
        assert_eq!(from_2026_06_22.len(), 0);

        let f = get_by_id(&db, formula_id).expect("get").expect("row");
        assert_eq!(f.sales_count, 1);
        assert!(f.last_sold_at.is_some());
    }

    #[test]
    fn create_sale_return_rejects_formula_line() {
        use crate::commands::sales::{
            create_final_bill, create_sale_return, CreateSaleReturnLine, CreateSaleReturnPayload,
        };
        let db = open_db();
        seed_user(&db, 1, "Owner");
        seed_item(&db, 1, "SKU1", "Sample");
        let formula_id = create(&db, 1, new_formula("8827", 250, false)).expect("create");

        let sale_id = create_final_bill(
            &db,
            1,
            NewSale {
                customer_id: None,
                kind: "final".into(),
                date: Some("2026-06-21".into()),
                bill_discount: 0,
                paid_amount: 250,
                payment_modes: vec![PaymentSplit {
                    mode: "cash".into(),
                    amount: 250,
                }],
                validity_days: None,
                acknowledge_flag: false,
                lines: vec![CartLine {
                    kind: "formula".into(),
                    item_id: None,
                    formula_id: Some(formula_id),
                    qty: 1.0,
                    price: 250,
                    unit_type: "unit".into(),
                    line_discount: 0,
                    shade_note: None,
                }],
            },
        )
        .expect("create final");

        let sale_item_id: i64 = db
            .with_raw(|c| {
                c.query_row(
                    "SELECT id FROM sale_items WHERE sale_id = ?1",
                    rusqlite::params![sale_id],
                    |r| r.get(0),
                )
            })
            .expect("query");

        let err = create_sale_return(
            &db,
            1,
            CreateSaleReturnPayload {
                sale_id,
                date: None,
                reason: None,
                payment_modes: vec![PaymentSplit {
                    mode: "cash".into(),
                    amount: 250,
                }],
                owner_pin: "".into(),
                lines: vec![CreateSaleReturnLine {
                    sale_item_id,
                    qty: 1,
                    refund_paise: 250,
                    shade_note: None,
                }],
            },
        )
        .expect_err("formula return rejected");
        let msg = format!("{err:?}");
        assert!(
            msg.contains("FormulaNotReturnable"),
            "expected FormulaNotReturnable variant, got {msg}"
        );
    }

    #[test]
    fn list_sales_ordered_newest_first() {
        let db = open_db();
        seed_user(&db, 1, "Owner");
        let formula_id = create(&db, 1, new_formula("8827", 100, false)).expect("create");

        db.with_conn::<_, _, rusqlite::Error>(|c| {
            for (i, date) in ["2026-06-18", "2026-06-19", "2026-06-20"].iter().enumerate() {
                let sale_id: i64 = c.query_row(
                    "INSERT INTO sales (no, customer_id, date, status, subtotal, bill_discount, total, paid_amount, payment_modes_json, user_id) \
                     VALUES (?1, NULL, ?2, 'final', 100, 0, 100, 100, '[{\"mode\":\"cash\",\"amount\":100}]', 1) \
                     RETURNING id",
                    rusqlite::params![format!("INV/2026-06-{}/{:03}", date, i + 1), *date],
                    |r| r.get(0),
                )?;
                c.execute(
                    "INSERT INTO sale_items (sale_id, kind, item_id, formula_id, qty, price, unit_type, line_discount, shade_note, line_order) \
                     VALUES (?1, 'formula', NULL, ?2, 1, 100, 'unit', 0, NULL, 0)",
                    rusqlite::params![sale_id, formula_id],
                )?;
            }
            Ok(())
        })
        .expect("seed sales");

        let rows = list_sales(&db, formula_id, None, None, None, 100).expect("list");
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].sale_date, "2026-06-20");
        assert_eq!(rows[1].sale_date, "2026-06-19");
        assert_eq!(rows[2].sale_date, "2026-06-18");
    }

    #[test]
    fn list_sales_filters_by_invoice_query() {
        let db = open_db();
        seed_user(&db, 1, "Owner");
        let formula_id = create(&db, 1, new_formula("8827", 100, false)).expect("create");
        db.with_conn::<_, _, rusqlite::Error>(|c| {
            c.execute(
                "INSERT INTO customers (id, name, phone, opening_balance_paise, is_active, created_at, updated_at) \
                 VALUES (1, 'Acme Paints', '9999999999', 0, 1, 0, 0)",
                [],
            )?;
            let walkin: i64 = c.query_row(
                "INSERT INTO sales (no, customer_id, date, status, subtotal, bill_discount, total, paid_amount, payment_modes_json, user_id) \
                 VALUES ('INV/walkin', NULL, '2026-06-19', 'final', 100, 0, 100, 100, '[{\"mode\":\"cash\",\"amount\":100}]', 1) \
                 RETURNING id",
                [],
                |r| r.get(0),
            )?;
            c.execute(
                "INSERT INTO sale_items (sale_id, kind, item_id, formula_id, qty, price, unit_type, line_discount, shade_note, line_order) \
                 VALUES (?1, 'formula', NULL, ?2, 1, 100, 'unit', 0, NULL, 0)",
                rusqlite::params![walkin, formula_id],
            )?;
            let acme: i64 = c.query_row(
                "INSERT INTO sales (no, customer_id, date, status, subtotal, bill_discount, total, paid_amount, payment_modes_json, user_id) \
                 VALUES ('INV/acme', 1, '2026-06-20', 'final', 100, 0, 100, 100, '[{\"mode\":\"cash\",\"amount\":100}]', 1) \
                 RETURNING id",
                [],
                |r| r.get(0),
            )?;
            c.execute(
                "INSERT INTO sale_items (sale_id, kind, item_id, formula_id, qty, price, unit_type, line_discount, shade_note, line_order) \
                 VALUES (?1, 'formula', NULL, ?2, 1, 100, 'unit', 0, NULL, 0)",
                rusqlite::params![acme, formula_id],
            )?;
            Ok(())
        })
        .expect("seed sales");

        let rows = list_sales(&db, formula_id, Some("acme"), None, None, 100).expect("query");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].customer_name.as_deref(), Some("Acme Paints"));
    }

    #[test]
    fn polymorphic_sale_items_query_returns_formula_lines() {
        let db = open_db();
        seed_user(&db, 1, "Owner");
        seed_item(&db, 1, "SKU1", "Sample");
        let formula_id = create(&db, 1, new_formula("8827", 100, false)).expect("create");
        let sale_id = sales::create_final_bill(
            &db,
            1,
            NewSale {
                customer_id: None,
                kind: "final".into(),
                date: Some("2026-06-21".into()),
                bill_discount: 0,
                paid_amount: 200,
                payment_modes: vec![PaymentSplit {
                    mode: "cash".into(),
                    amount: 200,
                }],
                validity_days: None,
                acknowledge_flag: false,
                lines: vec![
                    CartLine {
                        kind: "item".into(),
                        item_id: Some(1),
                        formula_id: None,
                        qty: 1.0,
                        price: 100,
                        unit_type: "unit".into(),
                        line_discount: 0,
                        shade_note: None,
                    },
                    CartLine {
                        kind: "formula".into(),
                        item_id: None,
                        formula_id: Some(formula_id),
                        qty: 1.0,
                        price: 100,
                        unit_type: "unit".into(),
                        line_discount: 0,
                        shade_note: None,
                    },
                ],
            },
        )
        .expect("create mixed");

        let loaded = sales::get(&db, sale_id).expect("get").expect("sale");
        assert_eq!(loaded.items.len(), 2);
        let formula_line = loaded
            .items
            .iter()
            .find(|i| i.kind == "formula")
            .expect("formula line");
        assert_eq!(formula_line.formula_id, Some(formula_id));
        assert_eq!(formula_line.item_id, None);
        assert!(formula_line.display_name.contains("8827"));

        let item_line = loaded
            .items
            .iter()
            .find(|i| i.kind == "item")
            .expect("item line");
        assert_eq!(item_line.item_id, Some(1));
        assert_eq!(item_line.formula_id, None);
    }

    #[test]
    fn conversion_quotation_preserves_formula_lines() {
        let db = open_db();
        seed_user(&db, 1, "Owner");
        seed_item(&db, 1, "SKU1", "Sample");
        let formula_id = create(&db, 1, new_formula("8827", 250, true)).expect("create");

        let qtn_id = sales::create_quotation(
            &db,
            1,
            NewSale {
                customer_id: None,
                kind: "quotation".into(),
                date: Some("2026-06-20".into()),
                bill_discount: 0,
                paid_amount: 0,
                payment_modes: vec![],
                validity_days: Some(7),
                acknowledge_flag: false,
                lines: vec![
                    CartLine {
                        kind: "item".into(),
                        item_id: Some(1),
                        formula_id: None,
                        qty: 2.0,
                        price: 100,
                        unit_type: "unit".into(),
                        line_discount: 0,
                        shade_note: None,
                    },
                    CartLine {
                        kind: "formula".into(),
                        item_id: None,
                        formula_id: Some(formula_id),
                        qty: 1.0,
                        price: 250,
                        unit_type: "unit".into(),
                        line_discount: 0,
                        shade_note: None,
                    },
                ],
            },
        )
        .expect("create qtn");

        let final_id = sales::convert_quotation(
            &db,
            1,
            sales::ConvertQuotation {
                quotation_id: qtn_id,
                paid_amount: 450,
                payment_modes: vec![PaymentSplit {
                    mode: "cash".into(),
                    amount: 450,
                }],
                acknowledge_flag: false,
            },
        )
        .expect("convert");

        let final_sale = sales::get(&db, final_id).expect("get").expect("sale");
        assert_eq!(final_sale.items.len(), 2);
        assert!(final_sale.items.iter().any(|i| i.kind == "formula"));
        assert!(final_sale.items.iter().any(|i| i.kind == "item"));
    }

    #[test]
    fn deactivated_formula_excluded_from_default_list() {
        let db = open_db();
        seed_user(&db, 1, "Owner");
        let id = create(&db, 1, new_formula("8827", 100, false)).expect("create");
        deactivate(&db, 1, id).expect("deactivate");

        let visible_in_default = list(&db, FormulaFilter::default()).expect("default list");
        assert_eq!(visible_in_default.len(), 1);
        assert!(!visible_in_default[0].is_active);

        let visible_when_active_only = list(
            &db,
            FormulaFilter {
                active: Some(true),
                query: None,
            },
        )
        .expect("active only");
        assert_eq!(visible_when_active_only.len(), 0);
    }
}

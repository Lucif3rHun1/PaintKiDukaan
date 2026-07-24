//! Final bill create + sale reads + create dispatcher.
use chrono::NaiveDate;
use rusqlite::params;
use rusqlite::OptionalExtension;
use crate::commands::auth::AppState;
use crate::commands::{customers, sequences};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::security::ipc_auth;
use super::helpers::*;
use super::fbill::create_fbill;
use super::quotation::create_quotation;

/// Create a final bill: validates credit rules, writes sale+items+stock_movements
/// atomically. If anything fails the whole transaction rolls back.
pub fn create_final_bill(db: &Db, user_id: i64, sale: NewSale) -> Result<i64, SaleError> {
    if sale.kind != "final" {
        return Err(SaleError::InvalidKind(sale.kind));
    }
    if sale.lines.is_empty() {
        return Err(SaleError::EmptyCart);
    }
    for (i, l) in sale.lines.iter().enumerate() {
        if l.qty <= 0.0 || !l.qty.is_finite() {
            return Err(SaleError::BadLineQty(i));
        }
        if l.price < 0 {
            return Err(SaleError::BadLinePrice(i));
        }
        if l.line_discount < 0 {
            return Err(SaleError::Other(anyhow::anyhow!(
                "line {}: line_discount cannot be negative",
                i
            )));
        }
    }
    if sale.bill_discount < 0 {
        return Err(SaleError::Other(anyhow::anyhow!(
            "bill_discount cannot be negative"
        )));
    }
    let total = cart_total(&sale.lines, sale.bill_discount);
    let customer = match sale.customer_id {
        Some(id) => Some(
            db.with_raw(|c| customers::get_by_id(c, id))
                .map_err(|e| SaleError::Other(anyhow::anyhow!("{e}")))?
                .ok_or_else(|| SaleError::Other(anyhow::anyhow!("customer {} not found", id)))?,
        ),
        None => None,
    };
    if let Some(ref c) = customer {
        if c.is_flagged && !sale.acknowledge_flag {
            return Err(SaleError::MustAcknowledgeFlag);
        }
    }
    validate_paid(sale.paid_amount, total, customer.as_ref())?;
    let paid_sum = modes_sum(&sale.payment_modes);
    if paid_sum != sale.paid_amount {
        return Err(SaleError::ModesSumMismatch {
            got: paid_sum,
            want: sale.paid_amount,
        });
    }
    for (i, m) in sale.payment_modes.iter().enumerate() {
        if m.amount <= 0 {
            return Err(SaleError::Other(anyhow::anyhow!(
                "payment split {}: amount must be > 0",
                i
            )));
        }
    }
    let payment_json = serde_json::to_string(&sale.payment_modes).unwrap_or_else(|_| "[]".into());
    let date = sale.date.unwrap_or_else(today);

    let id = db.with_conn_immediate(|c| -> Result<i64, SaleError> {
        // M3: mint sequence inside the transaction so a rollback doesn't waste a number.
        let no = sequences::mint_next_sale_no_with_conn(c, sequences::Kind::SaleInv)
            .map_err(SaleError::Other)?;
        let default_location: i64 = c.query_row(
            "SELECT id FROM locations WHERE is_active = 1 ORDER BY id LIMIT 1",
            [],
            |r| r.get(0),
        )?;
        let id: i64 = c.query_row(
            "INSERT INTO sales
                (no,customer_id,date,status,subtotal,bill_discount,total,
                 paid_amount,payment_modes_json,user_id)
             VALUES (?1,?2,?3,'final',?4,?5,?6,?7,?8,?9)
             RETURNING id",
            params![
                no,
                sale.customer_id,
                date,
                cart_subtotal(&sale.lines),
                sale.bill_discount,
                total,
                sale.paid_amount,
                payment_json,
                user_id,
            ],
            |r| r.get(0),
        )?;
        for (i, l) in sale.lines.iter().enumerate() {
            c.execute(
                "INSERT INTO sale_items
                    (sale_id,kind,item_id,formula_id,display_name,qty,price,unit_type,line_discount,shade_note,line_order)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                params![
                    id,
                    l.kind,
                    l.item_id,
                    l.formula_id,
                    l.display_name,
                    l.qty,
                    l.price,
                    l.unit_type,
                    l.line_discount,
                    l.shade_note,
                    i as i64
                ],
            )?;
            deduct_stock_for_line(c, StockLineRef::from(l), default_location, id, user_id)?;
        }
        let now_epoch = chrono::Utc::now().timestamp_millis();
        for pm in &sale.payment_modes {
            c.execute(
                "INSERT INTO sale_payments (sale_id, mode, amount_paise, created_at, created_by) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, pm.mode, pm.amount, now_epoch, user_id],
            )?;
        }
        Ok(id)
    })?;
    Ok(id)
}

// -----------------------------------------------------------------------------
// Reads.
// -----------------------------------------------------------------------------

pub fn get(db: &Db, id: i64) -> anyhow::Result<Option<Sale>> {
    db.with_conn(|c| {
        let sale = c
            .query_row(
                "SELECT id,no,customer_id,date,status,subtotal,bill_discount,
                        total,paid_amount,payment_modes_json,validity_days,
                        converted_from_id,user_id,created_at
                 FROM sales WHERE id = ?1",
                params![id],
                row_to_sale_header,
            )
            .optional()?;
        let sale = match sale {
            Some(s) => s,
            None => return Ok(None),
        };
        let items = load_items(c, sale.id)?;
        let customer_name = if let Some(cid) = sale.customer_id {
            customers::get_by_id(c, cid)?.map(|c| c.name)
        } else {
            None
        };
        Ok(Some(Sale {
            customer_name,
            items,
            ..sale
        }))
    })
}

/// Look up a sale by its human-readable number (`INV/...`, `QTN/...`).
/// Returns `None` when no row matches; same shape as `get`.
pub fn get_by_no(db: &Db, no: &str) -> anyhow::Result<Option<Sale>> {
    db.with_conn(|c| {
        let sale = c
            .query_row(
                "SELECT id,no,customer_id,date,status,subtotal,bill_discount,
                        total,paid_amount,payment_modes_json,validity_days,
                        converted_from_id,user_id,created_at
                 FROM sales WHERE no = ?1",
                params![no],
                row_to_sale_header,
            )
            .optional()?;
        let sale = match sale {
            Some(s) => s,
            None => return Ok(None),
        };
        let items = load_items(c, sale.id)?;
        let customer_name = if let Some(cid) = sale.customer_id {
            customers::get_by_id(c, cid)?.map(|c| c.name)
        } else {
            None
        };
        Ok(Some(Sale {
            customer_name,
            items,
            ..sale
        }))
    })
}

pub fn list(
    db: &Db,
    status: Option<&str>,
    from_date: Option<&str>,
    to_date: Option<&str>,
    limit: i64,
) -> anyhow::Result<Vec<Sale>> {
    db.with_conn(|c| {
        let mut sql = String::from(
            "SELECT s.id,s.no,s.customer_id,s.date,s.status,s.subtotal,s.bill_discount,
                    s.total,s.paid_amount,s.payment_modes_json,s.validity_days,
                    s.converted_from_id,s.user_id,s.created_at,
                    COALESCE(c.name, '')
             FROM sales s LEFT JOIN customers c ON c.id = s.customer_id",
        );
        let mut bound: Vec<rusqlite::types::Value> = Vec::new();
        let mut conds: Vec<String> = Vec::new();
        if let Some(s) = status {
            bound.push(s.to_string().into());
            conds.push(format!("s.status = ?{}", bound.len()));
        }
        if let Some(d) = from_date {
            bound.push(d.to_string().into());
            conds.push(format!("s.date >= ?{}", bound.len()));
        }
        if let Some(d) = to_date {
            let upper = NaiveDate::parse_from_str(d, "%Y-%m-%d")
                .ok()
                .and_then(|nd| nd.succ_opt())
                .map(|nd| nd.format("%Y-%m-%d").to_string())
                .unwrap_or_else(|| d.to_string());
            bound.push(upper.into());
            conds.push(format!("s.date < ?{}", bound.len()));
        }
        if !conds.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&conds.join(" AND "));
        }
        sql.push_str(" ORDER BY s.date DESC, s.id DESC LIMIT ?");
        bound.push(limit.into());
        sql.push_str(&format!("{}", bound.len()));
        let mut stmt = c.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(&bound), row_to_sale_header_with_name)?;
        let mut out = Vec::new();
        for r in rows {
            let mut s = r?;
            s.items = load_items(c, s.id)?;
            out.push(s);
        }
        Ok(out)
    })
}

// -----------------------------------------------------------------------------
// Tauri command surface.
// -----------------------------------------------------------------------------

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_create_sale(state: tauri::State<'_, AppState>, sale: NewSale) -> AppResult<i64> {
    ipc_auth::authorize_err("cmd_create_sale", state.inner())?;
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
    let user_id = user.id;
    match sale.kind.as_str() {
        "quotation" => create_quotation(db, user_id, sale).map_err(AppError::from),
        "final" => create_final_bill(db, user_id, sale).map_err(AppError::from),
        "fbill" => create_fbill(db, user_id, sale).map_err(AppError::from),
        k => Err(AppError::Validation(format!(
            "invalid kind: {} (expected 'quotation', 'final', or 'fbill')",
            k
        ))),
    }
}


#[tauri::command(rename_all = "snake_case")]
pub fn cmd_get_sale(state: tauri::State<'_, AppState>, id: i64) -> AppResult<Option<Sale>> {
    ipc_auth::authorize_err("cmd_get_sale", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    get(db, id).map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_get_sale_by_invoice_number(
    state: tauri::State<'_, AppState>,
    no: String,
) -> AppResult<Option<Sale>> {
    ipc_auth::authorize_err("cmd_get_sale_by_invoice_number", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    get_by_no(db, &no).map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_list_sales(
    state: tauri::State<'_, AppState>,
    status: Option<String>,
    from_date: Option<String>,
    to_date: Option<String>,
    limit: Option<i64>,
) -> AppResult<Vec<Sale>> {
    ipc_auth::authorize_err("cmd_list_sales", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    list(
        db,
        status.as_deref(),
        from_date.as_deref(),
        to_date.as_deref(),
        limit.unwrap_or(100),
    )
    .map_err(|e| AppError::Internal(e.to_string()))
}


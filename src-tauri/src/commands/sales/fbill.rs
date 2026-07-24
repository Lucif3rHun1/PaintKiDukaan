//! Fake-bill create + convert-to-fbill.
use rusqlite::params;
use rusqlite::OptionalExtension;
use crate::commands::auth::AppState;
use crate::commands::sequences;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::security::ipc_auth;
use super::helpers::*;

/// Create a fake bill — identical to a final bill except NO stock deduction.
/// Supports payments, customer, all fields. Not returnable. Re-open editable
/// via `edit_fbill`. Status = "fbill".
pub fn create_fbill(db: &Db, user_id: i64, sale: NewSale) -> Result<i64, SaleError> {
    if sale.kind != "fbill" {
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
    // Validate payments (same as final bill).
    validate_paid(sale.paid_amount, cart_total(&sale.lines, sale.bill_discount), None)?;
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
    let total = cart_total(&sale.lines, sale.bill_discount);
    let validity_days: Option<i64> = None; // fbills don't expire
    let no = sequences::mint_next_sale_no(db, sequences::Kind::SaleFbk)
        .map_err(SaleError::Other)?;
    let date = sale.date.unwrap_or_else(today);

    let id = db.with_conn_immediate(|c| -> Result<i64, SaleError> {
        let id: i64 = c.query_row(
            "INSERT INTO sales
                (no,customer_id,date,status,subtotal,bill_discount,total,
                 paid_amount,payment_modes_json,validity_days,user_id)
             VALUES (?1,?2,?3,'fbill',?4,?5,?6,?7,?8,?9,?10)
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
                validity_days,
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
                    i as i64,
                ],
            )?;
        }
        // Record payment splits (no stock deduction — that's the only difference from final bill).
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

// ----- Convert to FBill -----

/// Convert an existing final (or fbill) sale into a new FBill. Creates a brand
/// new sale with `kind = 'fbill'`, copying customer, lines, totals, and
/// payments. The source sale is left untouched — no stock reversal.
pub fn convert_to_fbill(db: &Db, user_id: i64, source_id: i64) -> Result<i64, SaleError> {
    let no = sequences::mint_next_sale_no(db, sequences::Kind::SaleFbk)
        .map_err(SaleError::Other)?;
    let date = today();

    let id = db.with_conn_immediate(|c| -> Result<i64, SaleError> {
        // Load source sale
        let (customer_id, subtotal, bill_discount, total, paid_amount, status, payment_json) = c
            .query_row(
                "SELECT customer_id, subtotal, bill_discount, total, paid_amount, \
                 status, payment_modes_json FROM sales WHERE id = ?1",
                params![source_id],
                |r| {
                    Ok((
                        r.get::<_, Option<i64>>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, i64>(4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, String>(6)?,
                    ))
                },
            )
            .optional()
            .map_err(SaleError::Db)?
            .ok_or(SaleError::Other(anyhow::anyhow!(
                "source sale {} not found",
                source_id
            )))?;

        if status != "final" && status != "fbill" {
            return Err(SaleError::Other(anyhow::anyhow!(
                "can only convert final or fbill sales (sale {} is '{}')",
                source_id,
                status
            )));
        }

        // Create new fbill — copy all financials, no stock effect, no expiry
        let new_id: i64 = c.query_row(
            "INSERT INTO sales
                (no, customer_id, date, status, subtotal, bill_discount, total,
                 paid_amount, payment_modes_json, user_id, created_by)
             VALUES (?1,?2,?3,'fbill',?4,?5,?6,?7,?8,?9,?10)
             RETURNING id",
            params![no, customer_id, date, subtotal, bill_discount, total, paid_amount, payment_json, user_id, user_id],
            |r| r.get(0),
        )?;

        // Copy line items from source
        c.execute(
            "INSERT INTO sale_items
                (sale_id, kind, item_id, formula_id, display_name, qty, price,
                 unit_type, line_discount, shade_note, line_order)
             SELECT ?1, si.kind, si.item_id, si.formula_id, si.display_name,
                    si.qty, si.price, si.unit_type, si.line_discount, si.shade_note, si.line_order
             FROM sale_items si WHERE si.sale_id = ?2
             ORDER BY si.line_order",
            params![new_id, source_id],
        )?;

        // Copy payment splits from source
        c.execute(
            "INSERT INTO sale_payments (sale_id, mode, amount_paise, created_at)
             SELECT ?1, sp.mode, sp.amount_paise, sp.created_at
             FROM sale_payments sp WHERE sp.sale_id = ?2",
            params![new_id, source_id],
        )?;

        Ok(new_id)
    })?;
    Ok(id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_convert_to_fbill(
    state: tauri::State<'_, AppState>,
    source_id: i64,
) -> AppResult<i64> {
    ipc_auth::authorize_err("cmd_convert_to_fbill", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let session = state
        .session
        .lock()
        .map_err(|_| AppError::Internal("session lock poisoned".into()))?;
    let user_id = session.as_ref().ok_or(AppError::NotUnlocked)?.id;
    convert_to_fbill(db, user_id, source_id).map_err(AppError::from)
}


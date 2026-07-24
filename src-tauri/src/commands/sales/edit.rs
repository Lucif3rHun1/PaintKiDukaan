//! FBill re-open / edit.
use rusqlite::params;
use rusqlite::OptionalExtension;
use serde::Deserialize;
use crate::commands::auth::AppState;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::security::ipc_auth;
use super::helpers::*;

/// Re-open and edit a fake bill. FBill is the only sale kind that allows
/// post-creation edit: replace the line items and recompute totals.
#[derive(Debug, Clone, Deserialize)]
pub struct EditFbillPayload {
    pub sale_id: i64,
    pub lines: Vec<CartLine>,
    pub bill_discount: i64,
    pub customer_id: Option<i64>,
    pub paid_amount: i64,
    pub payment_modes: Vec<PaymentSplit>,
}

pub fn edit_fbill(db: &Db, user_id: i64, payload: EditFbillPayload) -> Result<i64, SaleError> {
    if payload.lines.is_empty() {
        return Err(SaleError::EmptyCart);
    }
    for (i, l) in payload.lines.iter().enumerate() {
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
    if payload.bill_discount < 0 {
        return Err(SaleError::Other(anyhow::anyhow!(
            "bill_discount cannot be negative"
        )));
    }
    let subtotal = cart_subtotal(&payload.lines);
    let total = cart_total(&payload.lines, payload.bill_discount);

    let id = db.with_conn_immediate(|c| -> Result<i64, SaleError> {
        let status: String = c
            .query_row(
                "SELECT status FROM sales WHERE id = ?1",
                params![payload.sale_id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or(SaleError::Other(anyhow::anyhow!(
                "sale {} not found",
                payload.sale_id
            )))?;
        if status != "fbill" {
            return Err(SaleError::Other(anyhow::anyhow!(
                "only fbill sales can be re-opened (sale {} is status '{}')",
                payload.sale_id,
                status
            )));
        }
        let payment_json = serde_json::to_string(&payload.payment_modes).unwrap_or_else(|_| "[]".into());
        c.execute(
            "UPDATE sales SET subtotal = ?1, bill_discount = ?2, total = ?3, \
             customer_id = ?4, paid_amount = ?5, payment_modes_json = ?6, updated_by = ?7, \
             updated_at = datetime('now','localtime') \
             WHERE id = ?8",
            params![
                subtotal,
                payload.bill_discount,
                total,
                payload.customer_id,
                payload.paid_amount,
                payment_json,
                user_id,
                payload.sale_id
            ],
        )?;
        c.execute(
            "DELETE FROM sale_items WHERE sale_id = ?1",
            params![payload.sale_id],
        )?;
        c.execute(
            "DELETE FROM sale_payments WHERE sale_id = ?1",
            params![payload.sale_id],
        )?;
        for (i, l) in payload.lines.iter().enumerate() {
            c.execute(
                "INSERT INTO sale_items
                    (sale_id,kind,item_id,formula_id,display_name,qty,price,unit_type,line_discount,shade_note,line_order)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                params![
                    payload.sale_id,
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
        let now_epoch = chrono::Utc::now().timestamp_millis();
        for m in &payload.payment_modes {
            c.execute(
                "INSERT INTO sale_payments (sale_id, mode, amount_paise, created_at, created_by) \
                 VALUES (?1,?2,?3,?4,?5)",
                params![payload.sale_id, m.mode, m.amount, now_epoch, user_id],
            )?;
        }
        Ok(payload.sale_id)
    })?;
    Ok(id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_edit_sale(
    state: tauri::State<'_, AppState>,
    payload: EditFbillPayload,
) -> AppResult<i64> {
    ipc_auth::authorize_err("cmd_edit_sale", state.inner())?;
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
    edit_fbill(db, user_id, payload).map_err(AppError::from)
}


//! Quotation create + convert-to-final.
use rusqlite::params;
use rusqlite::OptionalExtension;
use crate::commands::auth::AppState;
use crate::commands::{customers, sequences};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::security::ipc_auth;
use super::helpers::*;

/// Create a quotation (no stock movements, no paid validation).
pub fn create_quotation(db: &Db, user_id: i64, sale: NewSale) -> Result<i64, SaleError> {
    if sale.kind != "quotation" {
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
    // Even for a quotation, paid_amount MUST be 0.
    if sale.paid_amount != 0 {
        return Err(SaleError::WalkinMustPayFull {
            paid: sale.paid_amount,
            total: 0,
        });
    }
    let total = cart_total(&sale.lines, sale.bill_discount);
    let validity_days = sale.validity_days.unwrap_or(7).max(1);
    let no =
        sequences::mint_next_sale_no(db, sequences::Kind::SaleQtn).map_err(SaleError::Other)?;
    let date = sale.date.unwrap_or_else(today);

    let id = db.with_conn_immediate(|c| -> Result<i64, SaleError> {
        let id: i64 = c.query_row(
            "INSERT INTO sales
                (no,customer_id,date,status,subtotal,bill_discount,total,
                 paid_amount,payment_modes_json,validity_days,user_id)
             VALUES (?1,?2,?3,'quotation',?4,?5,?6,0,'[]',?7,?8)
             RETURNING id",
            params![
                no,
                sale.customer_id,
                date,
                cart_subtotal(&sale.lines),
                sale.bill_discount,
                total,
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
        // Normalize payment splits into sale_payments for cash-summary queries.
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

/// Convert a quotation to a final bill. Creates new INV-no, inserts stock
/// movements, links back via converted_from_id.
pub fn convert_quotation(db: &Db, user_id: i64, req: ConvertQuotation) -> Result<i64, SaleError> {
    let date = today();

    let (new_id, _customer_id) =
        db.with_conn_immediate(|c| -> Result<(i64, Option<i64>), SaleError> {
            // M3: mint sequence inside the transaction so a rollback doesn't waste a number.
            let no = sequences::mint_next_sale_no_with_conn(c, sequences::Kind::SaleInv)
                .map_err(SaleError::Other)?;
            let default_location: i64 = c.query_row(
                "SELECT id FROM locations WHERE is_active = 1 ORDER BY id LIMIT 1",
                [],
                |r| r.get(0),
            )?;
            let row = c
                .query_row(
                    "SELECT id,customer_id,subtotal,bill_discount,total,status
                 FROM sales WHERE id = ?1",
                    params![req.quotation_id],
                    |r| {
                        Ok((
                            r.get::<_, i64>(0)?,
                            r.get::<_, Option<i64>>(1)?,
                            r.get::<_, i64>(2)?,
                            r.get::<_, i64>(3)?,
                            r.get::<_, i64>(4)?,
                            r.get::<_, String>(5)?,
                        ))
                    },
                )
                .optional()
                .map_err(SaleError::Db)?;
            let (qid, cust, subtotal, bill_disc, total, status) = match row {
                Some(v) => v,
                None => return Err(SaleError::QuotationNotFound(req.quotation_id)),
            };
            if status != "quotation" {
                return Err(SaleError::NotAQuotation(qid, status));
            }
            let customer = match cust {
                Some(id) => Some(
                    customers::get_by_id(c, id)
                        .map_err(|e| SaleError::Other(anyhow::anyhow!("{e}")))?
                        .ok_or_else(|| {
                            SaleError::Other(anyhow::anyhow!("customer {} not found", id))
                        })?,
                ),
                None => None,
            };
            if let Some(c) = customer.as_ref() {
                if c.is_flagged && !req.acknowledge_flag {
                    return Err(SaleError::MustAcknowledgeFlag);
                }
            }
            validate_paid(req.paid_amount, total, customer.as_ref())?;
            let paid_sum = modes_sum(&req.payment_modes);
            if paid_sum != req.paid_amount {
                return Err(SaleError::ModesSumMismatch {
                    got: paid_sum,
                    want: req.paid_amount,
                });
            }
            for (i, m) in req.payment_modes.iter().enumerate() {
                if m.amount <= 0 {
                    return Err(SaleError::Other(anyhow::anyhow!(
                        "payment split {}: amount must be > 0",
                        i
                    )));
                }
            }
            let payment_json =
                serde_json::to_string(&req.payment_modes).unwrap_or_else(|_| "[]".into());
            let new_id: i64 = c.query_row(
                "INSERT INTO sales
                (no,customer_id,date,status,subtotal,bill_discount,total,
                 paid_amount,payment_modes_json,converted_from_id,user_id)
             VALUES (?1,?2,?3,'final',?4,?5,?6,?7,?8,?9,?10)
             RETURNING id",
                params![
                    no,
                    cust,
                    date,
                    subtotal,
                    bill_disc,
                    total,
                    req.paid_amount,
                    payment_json,
                    qid,
                    user_id,
                ],
                |r| r.get(0),
            )?;
            let mut stmt = c.prepare(
                "SELECT kind,item_id,formula_id,display_name,qty,price,unit_type,line_discount,shade_note,line_order
             FROM sale_items WHERE sale_id = ?1 ORDER BY line_order",
            )?;
            let mut rows = stmt.query(params![qid])?;
            while let Some(r) = rows.next()? {
                let kind: String = r.get(0)?;
                let item_id: Option<i64> = r.get(1)?;
                let formula_id: Option<i64> = r.get(2)?;
                let display_name: Option<String> = r.get(3)?;
                let qty: f64 = r.get(4)?;
                let price: i64 = r.get(5)?;
                let unit_type: String = r.get(6)?;
                let line_discount: i64 = r.get(7)?;
                let shade_note: Option<String> = r.get(8)?;
                let line_order: i64 = r.get(9)?;
                c.execute(
                    "INSERT INTO sale_items
                    (sale_id,kind,item_id,formula_id,display_name,qty,price,unit_type,line_discount,shade_note,line_order)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                    params![
                        new_id,
                        kind,
                        item_id,
                        formula_id,
                        display_name,
                        qty,
                        price,
                        unit_type,
                        line_discount,
                        shade_note,
                        line_order
                    ],
                )?;
                deduct_stock_for_line(c, StockLineRef { kind: kind.as_str(), item_id, formula_id, qty }, default_location, new_id, user_id)?;
            }
            drop(rows);
            drop(stmt);
            Ok((new_id, cust))
        })?;
    Ok(new_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_convert_quotation(
    state: tauri::State<'_, AppState>,
    req: ConvertQuotation,
) -> AppResult<i64> {
    ipc_auth::authorize_err("cmd_convert_quotation", state.inner())?;
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
    convert_quotation(db, user_id, req).map_err(AppError::from)
}


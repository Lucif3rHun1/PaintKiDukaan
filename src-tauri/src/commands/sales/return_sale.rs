//! Sale returns (RET/...).
use rusqlite::params;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use crate::commands::_stock_movements::{insert_stock_movement, StockMovementKind};
use crate::commands::auth::AppState;
use crate::commands::sequences;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::security::ipc_auth;
use super::helpers::*;

// -----------------------------------------------------------------------------
// Sale returns (RET/...) — owner-PIN-gated, atomic.
// -----------------------------------------------------------------------------

struct FkGuard<'a>(&'a rusqlite::Connection);
impl Drop for FkGuard<'_> {
    fn drop(&mut self) {
        let _ = self.0.execute_batch("PRAGMA foreign_keys = ON");
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateSaleReturnPayload {
    pub sale_id: i64,
    pub customer_id: Option<i64>,
    pub date: Option<String>,
    pub reason: Option<String>,
    pub payment_modes: Vec<PaymentSplit>,
    pub owner_pin: String,
    pub lines: Vec<CreateSaleReturnLine>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateSaleReturnLine {
    pub sale_item_id: i64,
    pub item_id: Option<i64>,
    pub qty: f64,
    pub refund_paise: i64,
    pub shade_note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SaleReturn {
    pub id: i64,
    pub no: String,
    pub sale_id: i64,
    pub date: String,
    pub reason: Option<String>,
    pub refund_total: i64,
    pub payment_modes: Vec<PaymentSplit>,
    pub lines: Vec<SaleReturnLine>,
    pub created_at: String,
    pub created_by: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SaleReturnLine {
    pub sale_item_id: i64,
    pub item_name: String,
    pub qty: f64,
    pub refund_paise: i64,
    pub shade_note: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ReturnError {
    #[error("return must contain at least one line")]
    EmptyLines,
    #[error("line {0}: qty must be > 0")]
    BadLineQty(usize),
    #[error("line {0}: refund_paise must be >= 0")]
    BadRefund(usize),
    #[error("sale_item {1} does not belong to sale {2}")]
    SaleItemMismatch(usize, i64, i64),
    #[error(
        "line {line}: return qty {requested} + already-returned {already} exceeds sold {sold}"
    )]
    QtyExceedsSold {
        line: usize,
        requested: f64,
        already: f64,
        sold: f64,
    },
    #[error("payment_modes sum ({got}) must equal refund total ({want})")]
    ModesSumMismatch { got: i64, want: i64 },
    #[error("refund total ({refund}) exceeds paid amount ({paid})")]
    OverRefund { refund: i64, paid: i64 },
    #[error("sale {0} not found")]
    SaleNotFound(i64),
    #[error("sale {0} is not a final bill (status: {1})")]
    NotAFinalSale(i64, String),
    #[error("db error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("{0}")]
    Other(#[from] anyhow::Error),
}

impl From<ReturnError> for AppError {
    fn from(e: ReturnError) -> Self {
        match e {
            ReturnError::EmptyLines
            | ReturnError::BadLineQty(_)
            | ReturnError::BadRefund(_)
            | ReturnError::SaleItemMismatch(..)
            | ReturnError::QtyExceedsSold { .. }
            | ReturnError::ModesSumMismatch { .. }
            | ReturnError::NotAFinalSale(..)
            | ReturnError::OverRefund { .. } => AppError::Validation(e.to_string()),
            ReturnError::SaleNotFound(_) => AppError::NotFound("Sale not found".into()),
            ReturnError::Db(inner) => AppError::from(inner),
            ReturnError::Other(inner) => AppError::Internal(inner.to_string()),
        }
    }
}

pub fn create_sale_return(
    db: &Db,
    user_id: i64,
    payload: CreateSaleReturnPayload,
) -> Result<i64, ReturnError> {
    if payload.lines.is_empty() {
        return Err(ReturnError::EmptyLines);
    }
    for (i, l) in payload.lines.iter().enumerate() {
        if l.qty <= 0.0 || !l.qty.is_finite() {
            return Err(ReturnError::BadLineQty(i));
        }
        if l.refund_paise < 0 {
            return Err(ReturnError::BadRefund(i));
        }
    }

    // Mint return number BEFORE transaction to avoid reentrant mutex deadlock.
    let no = sequences::mint_next_sale_no(db, sequences::Kind::SaleRet)
        .map_err(ReturnError::Other)?;
    let logical_date = payload.date.unwrap_or_else(today);

    let new_id = db.with_conn_immediate(|c| -> Result<i64, ReturnError> {
        let is_standalone = payload.sale_id <= 0;

        // Linked return: validate the sale exists and is final.
        if !is_standalone {
            let row = c
                .query_row(
                    "SELECT status FROM sales WHERE id = ?1",
                    params![payload.sale_id],
                    |r| r.get::<_, String>(0),
                )
                .optional()?;
            let status = match row {
                Some(s) => s,
                None => return Err(ReturnError::SaleNotFound(payload.sale_id)),
            };
            if status != "final" {
                return Err(ReturnError::NotAFinalSale(payload.sale_id, status));
            }
        }

        // Per-line validation: each sale_item_id must belong to the original
        // sale AND requested qty must not exceed (sold - already_returned).
        // Skipped for standalone returns (sale_item_id == 0).
        if !is_standalone {
            for (i, l) in payload.lines.iter().enumerate() {
                if l.sale_item_id <= 0 {
                    continue;
                }
                let (sale_id_of_item, sold_qty): (i64, f64) = c
                    .query_row(
                        "SELECT sale_id, qty FROM sale_items WHERE id = ?1",
                        params![l.sale_item_id],
                        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, f64>(1)?)),
                    )
                    .optional()?
                    .ok_or(ReturnError::SaleItemMismatch(
                        i,
                        l.sale_item_id,
                        payload.sale_id,
                    ))?;
                if sale_id_of_item != payload.sale_id {
                    return Err(ReturnError::SaleItemMismatch(
                        i,
                        l.sale_item_id,
                        payload.sale_id,
                    ));
                }
                let already: f64 = c.query_row(
                    "SELECT COALESCE(SUM(qty), 0.0) FROM sale_return_lines
                         WHERE sale_item_id = ?1",
                    params![l.sale_item_id],
                    |r| r.get(0),
                )?;
                if l.qty + already > sold_qty {
                    return Err(ReturnError::QtyExceedsSold {
                        line: i,
                        requested: l.qty,
                        already,
                        sold: sold_qty,
                    });
                }
            }
        }

        let refund_total: i64 = payload
            .lines
            .iter()
            .map(|l| (l.qty * l.refund_paise as f64).round() as i64)
            .fold(0i64, |acc, v| acc.saturating_add(v));
        let modes_sum: i64 = payload
            .payment_modes
            .iter()
            .fold(0i64, |acc, m| acc.saturating_add(m.amount));
        if modes_sum != refund_total {
            return Err(ReturnError::ModesSumMismatch {
                got: modes_sum,
                want: refund_total,
            });
        }

        // Partition tenders: only the cash-equivalent portion reduces the
        // sale's paid_amount. `balance` tender adjusts the customer's
        // outstanding via a customer_payments row instead (below).
        let (cash_share_paise, balance_share_paise): (i64, i64) = payload
            .payment_modes
            .iter()
            .fold((0i64, 0i64), |(cash, bal), m| {
                if m.mode == "balance" {
                    (cash, bal.saturating_add(m.amount))
                } else {
                    (cash.saturating_add(m.amount), bal)
                }
            });

        if !is_standalone {
            let paid_amount: i64 = c.query_row(
                "SELECT paid_amount FROM sales WHERE id = ?1",
                params![payload.sale_id],
                |r| r.get(0),
            )?;
            if cash_share_paise > paid_amount {
                return Err(ReturnError::OverRefund {
                    refund: cash_share_paise,
                    paid: paid_amount,
                });
            }
        }

        let default_location: i64 = c
            .query_row(
                "SELECT id FROM locations WHERE is_active = 1 ORDER BY id LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| {
                ReturnError::Other(anyhow::anyhow!(
                    "No active location. Create one under Settings → Locations first."
                ))
            })?;
        let sale_location: i64 = if is_standalone {
            default_location
        } else {
            c.query_row(
                "SELECT location_id FROM stock_movements \
                 WHERE ref_kind = 'sale' AND ref_id = ?1 LIMIT 1",
                params![payload.sale_id],
                |r| r.get(0),
            )
            .unwrap_or(default_location)
        };

        let created_at = now_epoch_ms();
        let reason = payload.reason.clone();

        let _fk_guard = if is_standalone {
            c.execute_batch("PRAGMA foreign_keys = OFF")?;
            Some(FkGuard(c))
        } else {
            None
        };

        let return_id: i64 = c.query_row(
            "INSERT INTO sale_returns
                (no, sale_id, refund_total_paise, reason, date, created_at, created_by)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             RETURNING id",
            params![
                no,
                payload.sale_id,
                refund_total,
                reason,
                logical_date,
                created_at,
                user_id
            ],
            |r| r.get(0),
        )?;

        for l in &payload.lines {
            c.execute(
                "INSERT INTO sale_return_lines
                    (sale_return_id, sale_item_id, qty, refund_paise, shade_note,
                     created_at, created_by)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    return_id,
                    l.sale_item_id,
                    l.qty,
                    l.refund_paise,
                    l.shade_note,
                    created_at,
                    user_id,
                ],
            )?;
            let resolved_item_id = if l.sale_item_id > 0 {
                sale_item_id_to_item_id(c, l.sale_item_id)?
            } else {
                l.item_id
            };
            if let Some(item_id) = resolved_item_id {
                insert_stock_movement(
                    c,
                    item_id,
                    sale_location,
                    l.qty,
                    StockMovementKind::Return,
                    Some(return_id),
                    None,
                    created_at,
                    user_id,
                )?;
            }
        }

        drop(_fk_guard);

        for m in &payload.payment_modes {
            c.execute(
                "INSERT INTO sale_return_payments
                    (sale_return_id, mode, amount_paise, reference, created_at, created_by)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    return_id,
                    m.mode,
                    m.amount,
                    Option::<String>::None,
                    created_at,
                    user_id,
                ],
            )?;
        }

        if is_standalone {
            // Standalone return: no original sale to update paid_amount.
            // TODO: adjust customer opening_balance_paise if refund > paid.
        } else {
            // Refund reduces the customer's paid amount on the original sale so
            // the outstanding ledger stays correct. Only the cash-equivalent
            // share affects paid_amount; `balance` tenders settle via
            // customer_payments below and leave paid_amount untouched.
            c.execute(
                "UPDATE sales
                 SET paid_amount = MAX(0, paid_amount - ?1)
                 WHERE id = ?2",
                params![cash_share_paise, payload.sale_id],
            )?;

            // Balance tenders credit/debit the customer's outstanding ledger
            // by writing a customer_payments row linked to this sale.
            if balance_share_paise > 0 {
                let cust_id: Option<i64> = c
                    .query_row(
                        "SELECT customer_id FROM sales WHERE id = ?1",
                        params![payload.sale_id],
                        |r| r.get(0),
                    )
                    .ok();
                if let Some(cid) = cust_id {
                    c.execute(
                        "INSERT INTO customer_payments
                            (customer_id, sale_id, mode, amount_paise, reference, note, created_at, created_by)
                         VALUES (?1, ?2, 'balance', ?3, ?4, ?5, ?6, ?7)",
                        params![
                            cid,
                            payload.sale_id,
                            balance_share_paise,
                            no.as_str(),
                            format!("Refund via balance"),
                            created_at,
                            user_id,
                        ],
                    )?;
                }
            }
        }

        Ok(return_id)
    })?;
    Ok(new_id)
}

fn sale_item_id_to_item_id(
    c: &rusqlite::Connection,
    sale_item_id: i64,
) -> Result<Option<i64>, ReturnError> {
    Ok(c.query_row(
        "SELECT item_id FROM sale_items WHERE id = ?1",
        params![sale_item_id],
        |r| r.get::<_, Option<i64>>(0),
    )?)
}

pub(crate) fn row_to_sale_return(
    c: &rusqlite::Connection,
    header: &SaleReturnHeader,
) -> AppResult<SaleReturn> {
    let mut stmt = c.prepare(
        "SELECT sil.sale_item_id, COALESCE(b.name || ' · ' || COALESCE(i.name, ''), COALESCE(i.name, '')), sil.qty, sil.refund_paise, sil.shade_note
         FROM sale_return_lines sil
         LEFT JOIN items i ON i.id = (
             SELECT si.item_id FROM sale_items si WHERE si.id = sil.sale_item_id
         )
         LEFT JOIN brands b ON b.id = i.brand_id
         WHERE sil.sale_return_id = ?1
         ORDER BY sil.id",
    )?;
    let lines: Vec<SaleReturnLine> = stmt
        .query_map(params![header.id], |r| {
            Ok(SaleReturnLine {
                sale_item_id: r.get(0)?,
                item_name: r.get(1)?,
                qty: r.get(2)?,
                refund_paise: r.get(3)?,
                shade_note: r.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut stmt = c.prepare(
        "SELECT mode, amount_paise, COALESCE(reference, '') FROM sale_return_payments
         WHERE sale_return_id = ?1 ORDER BY id",
    )?;
    let payment_modes: Vec<PaymentSplit> = stmt
        .query_map(params![header.id], |r| {
            Ok(PaymentSplit {
                mode: r.get(0)?,
                amount: r.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(SaleReturn {
        id: header.id,
        no: header.no.clone(),
        sale_id: header.sale_id,
        date: header.date.clone(),
        reason: header.reason.clone(),
        refund_total: header.refund_total,
        payment_modes,
        lines,
        created_at: header.created_at.clone(),
        created_by: header.created_by,
    })
}

pub(crate) struct SaleReturnHeader {
    pub(crate) id: i64,
    pub(crate) no: String,
    pub(crate) sale_id: i64,
    pub(crate) date: String,
    pub(crate) reason: Option<String>,
    pub(crate) refund_total: i64,
    pub(crate) created_at: String,
    pub(crate) created_by: i64,
}

fn fetch_return_header(c: &rusqlite::Connection, id: i64) -> AppResult<Option<SaleReturnHeader>> {
    let row = c
        .query_row(
            "SELECT id, COALESCE(no, ''), sale_id,
                    COALESCE(date, CAST(created_at AS TEXT)) AS date,
                    reason, refund_total_paise,
                    CAST(created_at AS TEXT) AS created_at, created_by
             FROM sale_returns WHERE id = ?1",
            params![id],
            |r| {
                Ok(SaleReturnHeader {
                    id: r.get(0)?,
                    no: r.get(1)?,
                    sale_id: r.get(2)?,
                    date: r.get(3)?,
                    reason: r.get(4)?,
                    refund_total: r.get(5)?,
                    created_at: r.get(6)?,
                    created_by: r.get(7)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

pub fn get_return(db: &Db, id: i64) -> AppResult<Option<SaleReturn>> {
    db.with_raw(|c| {
        let header = match fetch_return_header(c, id)? {
            Some(h) => h,
            None => return Ok(None),
        };
        Ok(Some(row_to_sale_return(c, &header)?))
    })
}

pub fn list_returns(
    db: &Db,
    customer_id: Option<i64>,
    from_date: Option<&str>,
    to_date: Option<&str>,
    limit: i64,
) -> AppResult<Vec<SaleReturn>> {
    db.with_raw(|c| {
        let mut sql = String::from(
            "SELECT sr.id, COALESCE(sr.no, ''), sr.sale_id,
                    COALESCE(sr.date, CAST(sr.created_at AS TEXT)) AS date,
                    sr.reason, sr.refund_total_paise,
                    CAST(sr.created_at AS TEXT) AS created_at, sr.created_by
             FROM sale_returns sr
             JOIN sales s ON s.id = sr.sale_id
             WHERE 1=1",
        );
        let mut bound: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(cid) = customer_id {
            sql.push_str(&format!(" AND s.customer_id = ?{}", bound.len() + 1));
            bound.push(Box::new(cid));
        }
        if let Some(d) = from_date {
            if !d.is_empty() {
                sql.push_str(&format!(" AND sr.created_at >= ?{}", bound.len() + 1));
                bound.push(Box::new(date_to_ms(d)));
            }
        }
        if let Some(d) = to_date {
            if !d.is_empty() {
                sql.push_str(&format!(
                    " AND sr.created_at < ?{}",
                    bound.len() + 1
                ));
                bound.push(Box::new(date_to_ms(d) + 86_400_000));
            }
        }
        sql.push_str(&format!(" ORDER BY sr.id DESC LIMIT ?{}", bound.len() + 1));
        bound.push(Box::new(limit));
        let dyn_args: Vec<&dyn rusqlite::ToSql> =
            bound.iter().map(|b| &**b as &dyn rusqlite::ToSql).collect();
        let mut stmt = c.prepare(&sql)?;
        let rows = stmt.query_map(dyn_args.as_slice(), |r| {
            Ok(SaleReturnHeader {
                id: r.get(0)?,
                no: r.get(1)?,
                sale_id: r.get(2)?,
                date: r.get(3)?,
                reason: r.get(4)?,
                refund_total: r.get(5)?,
                created_at: r.get(6)?,
                created_by: r.get(7)?,
            })
        })?;
        let headers: Vec<SaleReturnHeader> = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from)?;
        let mut out = Vec::with_capacity(headers.len());
        for h in headers {
            out.push(row_to_sale_return(c, &h)?);
        }
        Ok(out)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_create_sale_return(
    state: tauri::State<'_, AppState>,
    payload: CreateSaleReturnPayload,
) -> AppResult<i64> {
    ipc_auth::authorize_err("cmd_create_sale_return", state.inner())?;
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
    // Owner PIN re-verification is only required for non-owner operators; the
    // owner has already authenticated at unlock time.
    if user.role != "owner" {
        crate::commands::auth::verify_owner_pin(state.inner(), &payload.owner_pin)?;
    }
    let user_id = user.id;
    create_sale_return(db, user_id, payload).map_err(AppError::from)
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_get_sale_return(
    state: tauri::State<'_, AppState>,
    id: i64,
) -> AppResult<Option<SaleReturn>> {
    ipc_auth::authorize_err("cmd_get_sale_return", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    get_return(db, id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_list_sale_returns(
    state: tauri::State<'_, AppState>,
    customer_id: Option<i64>,
    from_date: Option<String>,
    to_date: Option<String>,
    limit: Option<i64>,
) -> AppResult<Vec<SaleReturn>> {
    ipc_auth::authorize_err("cmd_list_sale_returns", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    list_returns(
        db,
        customer_id,
        from_date.as_deref(),
        to_date.as_deref(),
        limit.unwrap_or(100).max(1).min(500),
    )
}


//! Sales / POS commands.
//!
//! Per master plan §7.3. All writes happen in a BEGIN IMMEDIATE transaction so
//! stock movements, sale rows, and the sequence bump are atomic (E31–E35).
//!
//! Credit rules (E36–E40):
//!   - walk-in customer (None): paid_amount MUST equal total (else blocked)
//!   - attached customer (Some): paid_amount ∈ [0, total] (partial payments OK)
//!   - any case: paid_amount < 0 or paid_amount > total → blocked
//!
//! Flagged customer (E41–E42b):
//!   - caller (frontend) must call `is_flagged` first and surface the ⚠️ banner.
//!     This command never blocks based on flag; it only records the fact that
//!     the operator tapped Proceed by including `acknowledge_flag` in the
//!     request (an audit field). Backend rejects if flagged+final without ack.

use chrono::Local;
use rusqlite::params;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::commands::{customers, sequences};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::commands::auth::AppState;

// -----------------------------------------------------------------------------
// Public types (Tauri command arguments / return values).
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct Sale {
    pub id: i64,
    pub no: String,
    pub customer_id: Option<i64>,
    pub customer_name: Option<String>,
    pub date: String,
    pub status: String, // "quotation" | "final"
    pub subtotal: i64,
    pub bill_discount: i64,
    pub total: i64,
    pub paid_amount: i64,
    pub payment_modes: Vec<PaymentSplit>,
    pub validity_days: Option<i64>,
    pub converted_from_id: Option<i64>,
    pub user_id: i64,
    pub created_at: String,
    pub items: Vec<SaleItem>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SaleItem {
    pub item_id: i64,
    pub item_name: String,
    pub qty: i64,                 // base units (INTEGER)
    pub price: i64,
    pub unit_type: String,        // "unit" | "box"
    pub line_discount: i64,
    pub shade_note: Option<String>,
    pub line_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaymentSplit {
    pub mode: String, // "cash" | "upi" | "card" | "bank" | "cheque"
    pub amount: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CartLine {
    pub item_id: i64,
    pub qty: f64, // BASE units (frontend already converted box → base)
    pub price: i64,
    pub unit_type: String,
    pub line_discount: i64,
    pub shade_note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewSale {
    pub customer_id: Option<i64>,
    pub kind: String,            // "quotation" | "final"
    pub date: Option<String>,    // ISO YYYY-MM-DD; default = today
    pub bill_discount: i64,
    pub paid_amount: i64,
    pub payment_modes: Vec<PaymentSplit>,
    pub validity_days: Option<i64>,
    pub acknowledge_flag: bool,  // audit: cashier tapped "Proceed" past the banner
    pub lines: Vec<CartLine>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConvertQuotation {
    pub quotation_id: i64,
    pub paid_amount: i64,
    pub payment_modes: Vec<PaymentSplit>,
    pub acknowledge_flag: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HoldBill {
    pub payload_json: String,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HeldBill {
    pub id: i64,
    pub note: Option<String>,
    pub created_at: String,
    pub payload_json: String,
}

// -----------------------------------------------------------------------------
// Errors (typed so the frontend can distinguish business-rule rejections from
// infrastructure failures).
// -----------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum SaleError {
    #[error("cart is empty")]
    EmptyCart,
    #[error("line {0}: qty must be > 0")]
    BadLineQty(usize),
    #[error("line {0}: price must be >= 0")]
    BadLinePrice(usize),
    #[error("paid_amount must be >= 0")]
    NegativePaid,
    #[error("paid_amount ({paid}) exceeds total ({total})")]
    PaidExceedsTotal { paid: i64, total: i64 },
    #[error("paid_amount ({paid}) does not match total ({total}) for walk-in or non-credit customer")]
    WalkinMustPayFull { paid: i64, total: i64 },
    #[error("payment_modes sum ({got}) must equal paid_amount ({want})")]
    ModesSumMismatch { got: i64, want: i64 },
    #[error("flagged customer — must set acknowledge_flag=true")]
    MustAcknowledgeFlag,
    #[error("quotation not found: {0}")]
    QuotationNotFound(i64),
    #[error("only quotations can be converted (sale {0} is {1})")]
    NotAQuotation(i64, String),
    #[error("invalid kind: {0} (expected 'quotation' or 'final')")]
    InvalidKind(String),
    #[error("db error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("{0}")]
    Other(#[from] anyhow::Error),
}

// -----------------------------------------------------------------------------
// Cart math (pure; used by both create paths and the API surface).
// -----------------------------------------------------------------------------

/// Compute the subtotal from cart lines. Each line value = qty * price -
/// line_discount (all in paise, qty is f64 base units).
pub fn line_value(line: &CartLine) -> i64 {
    let raw = (line.qty * line.price as f64).round() as i64 - line.line_discount;
    raw.max(0)
}

pub fn cart_subtotal(lines: &[CartLine]) -> i64 {
    lines.iter().map(line_value).sum()
}

pub fn cart_total(lines: &[CartLine], bill_discount: i64) -> i64 {
    (cart_subtotal(lines) - bill_discount).max(0)
}

pub fn modes_sum(modes: &[PaymentSplit]) -> i64 {
    modes.iter().map(|m| m.amount).sum()
}

/// Validate paid_amount against the credit rule. Returns Ok(()) or an error.
pub fn validate_paid(
    paid: i64,
    total: i64,
    customer: Option<&customers::Customer>,
) -> Result<(), SaleError> {
    if paid < 0 {
        return Err(SaleError::NegativePaid);
    }
    if paid > total {
        return Err(SaleError::PaidExceedsTotal {
            paid,
            total,
        });
    }
    let has_customer = customer.is_some();
    if !has_customer && paid != total {
        return Err(SaleError::WalkinMustPayFull {
            paid,
            total,
        });
    }
    Ok(())
}

// -----------------------------------------------------------------------------
// Create paths.
// -----------------------------------------------------------------------------

/// Create a quotation (no stock movements, no paid validation).
pub fn create_quotation(db: &Db, user_id: i64, sale: NewSale) -> Result<i64, SaleError> {
    if sale.kind != "quotation" {
        return Err(SaleError::InvalidKind(sale.kind));
    }
    if sale.lines.is_empty() {
        return Err(SaleError::EmptyCart);
    }
    for (i, l) in sale.lines.iter().enumerate() {
        if l.qty <= 0.0 || l.qty.is_nan() {
            return Err(SaleError::BadLineQty(i));
        }
        if l.price < 0 {
            return Err(SaleError::BadLinePrice(i));
        }
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
    let no = sequences::mint_next_sale_no(db, sequences::Kind::SaleQtn)
        .map_err(SaleError::Other)?;
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
                    (sale_id,item_id,qty,price,unit_type,line_discount,shade_note,line_order)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![
                    id,
                    l.item_id,
                    l.qty.round() as i64,
                    l.price,
                    l.unit_type,
                    l.line_discount,
                    l.shade_note,
                    i as i64,
                ],
            )?;
        }
        Ok(id)
    })?;
    Ok(id)
}

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
        if l.qty <= 0.0 || l.qty.is_nan() {
            return Err(SaleError::BadLineQty(i));
        }
        if l.price < 0 {
            return Err(SaleError::BadLinePrice(i));
        }
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
    let payment_json =
        serde_json::to_string(&sale.payment_modes).unwrap_or_else(|_| "[]".into());
    let no = sequences::mint_next_sale_no(db, sequences::Kind::SaleInv)
        .map_err(SaleError::Other)?;
    let date = sale.date.unwrap_or_else(today);
    // Default location: the row flagged is_default=1.
    let default_location: i64 = db
        .with_conn(|c| -> Result<i64, SaleError> {
            // Canonical §5.1 has no `is_default` on locations; pick the lowest id.
            Ok(c.query_row(
                "SELECT id FROM locations WHERE is_active = 1 ORDER BY id LIMIT 1",
                [],
                |r| r.get(0),
            )?)
        })?;

    let id = db.with_conn_immediate(|c| -> Result<i64, SaleError> {
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
                    (sale_id,item_id,qty,price,unit_type,line_discount,shade_note,line_order)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![id, l.item_id, (l.qty.round() as i64), l.price, l.unit_type, l.line_discount, l.shade_note, i as i64],
            )?;
            c.execute(
                "INSERT INTO stock_movements
                    (item_id,location_id,qty,type,ref_type,ref_id,user_id,created_at)
                 VALUES (?1,?2,?3,'sale','sale',?4,?5,?6)",
                params![l.item_id, default_location, -(l.qty.round() as i64), id, user_id, now()],
            )?;
        }
        Ok(id)
    })?;
    Ok(id)
}

/// Convert a quotation to a final bill. Creates new INV-no, inserts stock
/// movements, links back via converted_from_id.
pub fn convert_quotation(db: &Db, user_id: i64, req: ConvertQuotation) -> Result<i64, SaleError> {
    let no = sequences::mint_next_sale_no(db, sequences::Kind::SaleInv)
        .map_err(SaleError::Other)?;
    let date = today();
    let default_location: i64 = db
        .with_conn(|c| -> Result<i64, SaleError> {
            Ok(c.query_row(
                "SELECT id FROM locations WHERE is_active = 1 ORDER BY id LIMIT 1",
                [],
                |r| r.get(0),
            )?)
        })?;

    let (new_id, _customer_id) = db.with_conn_immediate(|c| -> Result<(i64, Option<i64>), SaleError> {
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
        // Apply credit rules to the converted bill.
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
        let payment_json =
            serde_json::to_string(&req.payment_modes).unwrap_or_else(|_| "[]".into());
        // Insert the new final sale, pointing back at the quotation.
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
        // Copy sale_items; insert stock_movements for each line.
        let mut stmt = c.prepare(
            "SELECT item_id,qty,price,unit_type,line_discount,shade_note,line_order
             FROM sale_items WHERE sale_id = ?1 ORDER BY line_order",
        )?;
        let mut rows = stmt.query(params![qid])?;
        while let Some(r) = rows.next()? {
            let item_id: i64 = r.get(0)?;
            let qty: i64 = r.get(1)?;
            let price: i64 = r.get(2)?;
            let unit_type: String = r.get(3)?;
            let line_discount: i64 = r.get(4)?;
            let shade_note: Option<String> = r.get(5)?;
            let line_order: i64 = r.get(6)?;
            c.execute(
                "INSERT INTO sale_items
                    (sale_id,item_id,qty,price,unit_type,line_discount,shade_note,line_order)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![new_id, item_id, qty, price, unit_type, line_discount, shade_note, line_order],
            )?;
            c.execute(
                "INSERT INTO stock_movements
                    (item_id,location_id,qty,type,ref_type,ref_id,user_id,created_at)
                 VALUES (?1,?2,?3,'sale','sale',?4,?5,?6)",
                params![item_id, default_location, -qty, new_id, user_id, now()],
            )?;
        }
        drop(rows);
        drop(stmt);
        Ok((new_id, cust))
    })?;
    Ok(new_id)
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

pub fn list(
    db: &Db,
    status: Option<&str>,
    limit: i64,
) -> anyhow::Result<Vec<Sale>> {
    db.with_conn(|c| {
        let mut sql = String::from(
            "SELECT id,no,customer_id,date,status,subtotal,bill_discount,
                    total,paid_amount,payment_modes_json,validity_days,
                    converted_from_id,user_id,created_at
             FROM sales",
        );
        let mut bound = Vec::new();
        if let Some(s) = status {
            sql.push_str(" WHERE status = ?1");
            bound.push(s.to_string());
        }
        sql.push_str(" ORDER BY date DESC, id DESC LIMIT ?");
        sql.push_str(&format!("{}", bound.len() + 1));
        bound.push(limit.to_string());
        let mut stmt = c.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(&bound), row_to_sale_header)?;
        let mut out = Vec::new();
        for r in rows {
            let s = r?;
            let items = load_items(c, s.id)?;
            let customer_name = if let Some(cid) = s.customer_id {
                customers::get_by_id(c, cid)?.map(|c| c.name)
            } else {
                None
            };
            out.push(Sale {
                customer_name,
                items,
                ..s
            });
        }
        Ok(out)
    })
}

fn load_items(c: &rusqlite::Connection, sale_id: i64) -> anyhow::Result<Vec<SaleItem>> {
    let mut stmt = c.prepare(
        "SELECT si.item_id,i.name,si.qty,si.price,si.unit_type,si.line_discount,
                si.shade_note,si.line_order
         FROM sale_items si
         JOIN items i ON i.id = si.item_id
         WHERE si.sale_id = ?1
         ORDER BY si.line_order",
    )?;
    let rows = stmt.query_map(params![sale_id], |r| {
        Ok(SaleItem {
            item_id: r.get(0)?,
            item_name: r.get(1)?,
            qty: r.get(2)?,
            price: r.get(3)?,
            unit_type: r.get(4)?,
            line_discount: r.get(5)?,
            shade_note: r.get(6)?,
            line_order: r.get(7)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn row_to_sale_header(r: &rusqlite::Row<'_>) -> rusqlite::Result<Sale> {
    let modes_json: String = r.get(9)?;
    let modes: Vec<PaymentSplit> = serde_json::from_str(&modes_json).unwrap_or_default();
    Ok(Sale {
        id: r.get(0)?,
        no: r.get(1)?,
        customer_id: r.get(2)?,
        customer_name: None,
        date: r.get(3)?,
        status: r.get(4)?,
        subtotal: r.get(5)?,
        bill_discount: r.get(6)?,
        total: r.get(7)?,
        paid_amount: r.get(8)?,
        payment_modes: modes,
        validity_days: r.get(10)?,
        converted_from_id: r.get(11)?,
        user_id: r.get(12)?,
        created_at: r.get(13)?,
        items: Vec::new(),
    })
}

// -----------------------------------------------------------------------------
// Held / parked bills (§7.3).
// -----------------------------------------------------------------------------

pub fn hold_bill(db: &Db, user_id: i64, hb: HoldBill) -> anyhow::Result<i64> {
    db.with_conn_immediate(|c| -> anyhow::Result<i64> {
        let id: i64 = c.query_row(
            "INSERT INTO held_bills(payload_json,note,user_id,created_at)
             VALUES (?1,?2,?3,?4) RETURNING id",
            params![hb.payload_json, hb.note, user_id, now()],
            |r| r.get(0),
        )?;
        Ok(id)
    })
}

pub fn list_held(db: &Db) -> anyhow::Result<Vec<HeldBill>> {
    db.with_conn(|c| -> anyhow::Result<Vec<HeldBill>> {
        let mut stmt = c.prepare(
            "SELECT id,note,created_at,payload_json FROM held_bills ORDER BY id DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(HeldBill {
                id: r.get(0)?,
                note: r.get(1)?,
                created_at: r.get(2)?,
                payload_json: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
}

pub fn delete_held(db: &Db, id: i64) -> anyhow::Result<usize> {
    db.with_conn(|c| -> anyhow::Result<usize> {
        Ok(c.execute("DELETE FROM held_bills WHERE id = ?1", params![id])?)
    })
}

// -----------------------------------------------------------------------------
// Tauri command surface.
// -----------------------------------------------------------------------------

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_create_sale(
    state: tauri::State<'_, AppState>,
    sale: NewSale,
) -> AppResult<i64> {
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let session = state.session.lock().map_err(|_| AppError::Internal("session lock poisoned".into()))?;
    let user = session.as_ref().ok_or(AppError::NotUnlocked)?;
    let user_id = user.id;
    match sale.kind.as_str() {
        "quotation" => create_quotation(db, user_id, sale).map_err(|e| AppError::Internal(e.to_string())),
        "final" => create_final_bill(db, user_id, sale).map_err(|e| AppError::Internal(e.to_string())),
        k => Err(AppError::Internal(format!("invalid kind: {}", k))),
    }
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_convert_quotation(
    state: tauri::State<'_, AppState>,
    req: ConvertQuotation,
) -> AppResult<i64> {
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let session = state.session.lock().map_err(|_| AppError::Internal("session lock poisoned".into()))?;
    let user = session.as_ref().ok_or(AppError::NotUnlocked)?;
    let user_id = user.id;
    convert_quotation(db, user_id, req).map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_get_sale(state: tauri::State<'_, AppState>, id: i64) -> AppResult<Option<Sale>> {
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    get(db, id).map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_list_sales(
    state: tauri::State<'_, AppState>,
    status: Option<String>,
    limit: Option<i64>,
) -> AppResult<Vec<Sale>> {
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    list(db, status.as_deref(), limit.unwrap_or(100)).map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_hold_bill(
    state: tauri::State<'_, AppState>,
    hb: HoldBill,
) -> AppResult<i64> {
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let session = state.session.lock().map_err(|_| AppError::Internal("session lock poisoned".into()))?;
    let user = session.as_ref().ok_or(AppError::NotUnlocked)?;
    let user_id = user.id;
    hold_bill(db, user_id, hb).map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_list_held(state: tauri::State<'_, AppState>) -> AppResult<Vec<HeldBill>> {
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    list_held(db).map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_delete_held(state: tauri::State<'_, AppState>, id: i64) -> AppResult<usize> {
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    delete_held(db, id).map_err(|e| AppError::Internal(e.to_string()))
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

fn today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn now() -> String {
    Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

// -----------------------------------------------------------------------------
// Tests for cart math + credit rules.
// -----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn line(qty: f64, price: i64, disc: i64) -> CartLine {
        CartLine {
            item_id: 1,
            qty,
            price,
            unit_type: "unit".into(),
            line_discount: disc,
            shade_note: None,
        }
    }

    #[test]
    fn line_value_basic() {
        let v = line_value(&line(2.0, 1500, 100));
        // 2 * 1500 - 100 = 2900
        assert_eq!(v, 2900);
    }

    #[test]
    fn line_value_does_not_go_negative() {
        let v = line_value(&line(1.0, 100, 200));
        assert_eq!(v, 0);
    }

    #[test]
    fn subtotal_and_total_with_bill_discount() {
        let lines = vec![line(1.0, 1000, 0), line(2.0, 500, 0)];
        assert_eq!(cart_subtotal(&lines), 2000);
        assert_eq!(cart_total(&lines, 200), 1800);
    }

    #[test]
    fn walkin_must_pay_full() {
        // No customer → walk-in → paid must equal total.
        let err = validate_paid(900, 1000, None).unwrap_err();
        matches!(err, SaleError::WalkinMustPayFull { .. });
        assert!(validate_paid(1000, 1000, None).is_ok());
    }

    #[test]
    fn attached_customer_allows_partial() {
        let c = customers::Customer {
            id: 1,
            name: "C".into(),
            phone: "9999000001".into(),
            type_id: None,
            type_name: None,
            is_flagged: false,
            opening_balance: 0,
            notes: None,
            is_active: true,
            created_at: "2026-01-01 00:00:00".into(),
            updated_at: "2026-01-01 00:00:00".into(),
        };
        assert!(validate_paid(0, 1000, Some(&c)).is_ok());
        assert!(validate_paid(500, 1000, Some(&c)).is_ok());
        assert!(validate_paid(1000, 1000, Some(&c)).is_ok());
    }

    #[test]
    fn paid_over_total_blocked() {
        let err = validate_paid(2000, 1000, None).unwrap_err();
        matches!(err, SaleError::PaidExceedsTotal { .. });
    }

    #[test]
    fn payment_modes_sum_must_match_paid() {
        let modes = vec![
            PaymentSplit { mode: "cash".into(), amount: 500 },
            PaymentSplit { mode: "upi".into(), amount: 500 },
        ];
        assert_eq!(modes_sum(&modes), 1000);
    }
}

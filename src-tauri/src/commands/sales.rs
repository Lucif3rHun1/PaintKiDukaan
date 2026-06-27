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

use crate::commands::auth::AppState;
use crate::commands::{customers, sequences};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::security::ipc_auth;

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
    pub kind: String, // "item" | "formula"
    pub item_id: Option<i64>,
    pub formula_id: Option<i64>,
    pub display_name: String,
    pub qty: i64, // base units (INTEGER)
    pub price: i64,
    pub unit_type: String, // "unit" | "box"
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
    pub kind: String, // "item" | "formula"
    pub item_id: Option<i64>,
    pub formula_id: Option<i64>,
    pub qty: f64, // BASE units (frontend already converted box → base)
    pub price: i64,
    pub unit_type: String,
    pub line_discount: i64,
    pub shade_note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewSale {
    pub customer_id: Option<i64>,
    pub kind: String,         // "quotation" | "final"
    pub date: Option<String>, // ISO YYYY-MM-DD; default = today
    pub bill_discount: i64,
    pub paid_amount: i64,
    pub payment_modes: Vec<PaymentSplit>,
    pub validity_days: Option<i64>,
    pub acknowledge_flag: bool, // audit: cashier tapped "Proceed" past the banner
    pub lines: Vec<CartLine>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConvertQuotation {
    pub quotation_id: i64,
    pub paid_amount: i64,
    pub payment_modes: Vec<PaymentSplit>,
    pub acknowledge_flag: bool,
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
    #[error("walk-in customers must be paid in full (paid={paid}, total={total})")]
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
    #[error("insufficient stock for item '{item_name}' (id={item_id}): available {available}, need {requested}")]
    InsufficientStock {
        item_id: i64,
        item_name: String,
        available: i64,
        requested: i64,
    },
    #[error("db error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("{0}")]
    Other(#[from] anyhow::Error),
}

/// Map typed business-rule errors to user-facing AppError variants so the
/// toast renders a meaningful message instead of the generic
/// "An unexpected error occurred." string used by `Internal`.
impl From<SaleError> for AppError {
    fn from(e: SaleError) -> Self {
        match e {
            SaleError::EmptyCart
            | SaleError::BadLineQty(_)
            | SaleError::BadLinePrice(_)
            | SaleError::NegativePaid
            | SaleError::PaidExceedsTotal { .. }
            | SaleError::WalkinMustPayFull { .. }
            | SaleError::ModesSumMismatch { .. }
            | SaleError::MustAcknowledgeFlag
            | SaleError::QuotationNotFound(_)
            | SaleError::NotAQuotation(_, _)
            | SaleError::InvalidKind(_) => AppError::Validation(e.to_string()),
            SaleError::InsufficientStock { item_name, available, requested, .. } => {
                let avail = available.max(0);
                AppError::Validation(format!(
                    "Not enough stock for '{item_name}'. Only {avail} available, you need {requested}."
                ))
            }
            SaleError::Db(inner) => AppError::from(inner),
            SaleError::Other(inner) => AppError::Internal(inner.to_string()),
        }
    }
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
        return Err(SaleError::PaidExceedsTotal { paid, total });
    }
    let has_customer = customer.is_some();
    if !has_customer && paid != total {
        return Err(SaleError::WalkinMustPayFull { paid, total });
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
                    (sale_id,kind,item_id,formula_id,qty,price,unit_type,line_discount,shade_note,line_order)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                params![
                    id,
                    l.kind,
                    l.item_id,
                    l.formula_id,
                    l.qty.round() as i64,
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
    let payment_json = serde_json::to_string(&sale.payment_modes).unwrap_or_else(|_| "[]".into());
    let no =
        sequences::mint_next_sale_no(db, sequences::Kind::SaleInv).map_err(SaleError::Other)?;
    let date = sale.date.unwrap_or_else(today);
    // Default location: the row flagged is_default=1.
    let default_location: i64 = db.with_conn(|c| -> Result<i64, SaleError> {
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
                    (sale_id,kind,item_id,formula_id,qty,price,unit_type,line_discount,shade_note,line_order)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                params![
                    id,
                    l.kind,
                    l.item_id,
                    l.formula_id,
                    (l.qty.round() as i64),
                    l.price,
                    l.unit_type,
                    l.line_discount,
                    l.shade_note,
                    i as i64
                ],
            )?;
            // Stock movements for real items AND formulas with a linked base item.
            if let Some(item_id) = l.item_id {
                let requested = l.qty.round() as i64;
                let available: i64 = c.query_row(
                    "SELECT COALESCE(qty, 0) FROM stock_balances WHERE item_id = ?1 AND location_id = ?2",
                    params![item_id, default_location],
                    |r| r.get(0),
                ).unwrap_or(0);
                if available < requested {
                    let item_name: String = c.query_row(
                        "SELECT name FROM items WHERE id = ?1",
                        params![item_id],
                        |r| r.get(0),
                    ).unwrap_or_else(|_| "unknown".into());
                    return Err(SaleError::InsufficientStock { item_id, item_name, available, requested });
                }
                c.execute(
                    "INSERT INTO stock_movements
                        (item_id,location_id,qty,kind_id,unit_id,ref_kind,ref_id,created_by,created_at)
                     VALUES (?1,?2,?3,(SELECT id FROM stock_movement_kinds WHERE code='sale'),(SELECT unit_id FROM items WHERE id=?1),'sale',?4,?5,?6)",
                    params![
                        item_id,
                        default_location,
                        -requested,
                        id,
                        user_id,
                        now()
                    ],
                )?;
            } else if l.kind == "formula" {
                // Formulas with a linked base item move that base item from stock.
                if let Some(fid) = l.formula_id {
                    let base_item_id: Option<i64> = c.query_row(
                        "SELECT base_item_id FROM formulas WHERE id = ?1",
                        params![fid],
                        |r| r.get(0),
                    ).unwrap_or(None);
                    if let Some(base_id) = base_item_id {
                        let requested = l.qty.round() as i64;
                        let available: i64 = c.query_row(
                            "SELECT COALESCE(qty, 0) FROM stock_balances WHERE item_id = ?1 AND location_id = ?2",
                            params![base_id, default_location],
                            |r| r.get(0),
                        ).unwrap_or(0);
                        if available < requested {
                            let item_name: String = c.query_row(
                                "SELECT name FROM items WHERE id = ?1",
                                params![base_id],
                                |r| r.get(0),
                            ).unwrap_or_else(|_| "unknown".into());
                            return Err(SaleError::InsufficientStock { item_id: base_id, item_name, available, requested });
                        }
                        c.execute(
                            "INSERT INTO stock_movements
                                (item_id,location_id,qty,kind_id,unit_id,ref_kind,ref_id,created_by,created_at)
                             VALUES (?1,?2,?3,(SELECT id FROM stock_movement_kinds WHERE code='sale'),(SELECT unit_id FROM items WHERE id=?1),'sale',?4,?5,?6)",
                            params![base_id, default_location, -requested, id, user_id, now()],
                        )?;
                    }
                }
            }
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
    let no =
        sequences::mint_next_sale_no(db, sequences::Kind::SaleInv).map_err(SaleError::Other)?;
    let date = today();
    let default_location: i64 = db.with_conn(|c| -> Result<i64, SaleError> {
        Ok(c.query_row(
            "SELECT id FROM locations WHERE is_active = 1 ORDER BY id LIMIT 1",
            [],
            |r| r.get(0),
        )?)
    })?;

    let (new_id, _customer_id) =
        db.with_conn_immediate(|c| -> Result<(i64, Option<i64>), SaleError> {
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
                "SELECT kind,item_id,formula_id,qty,price,unit_type,line_discount,shade_note,line_order
             FROM sale_items WHERE sale_id = ?1 ORDER BY line_order",
            )?;
            let mut rows = stmt.query(params![qid])?;
            while let Some(r) = rows.next()? {
                let kind: String = r.get(0)?;
                let item_id: Option<i64> = r.get(1)?;
                let formula_id: Option<i64> = r.get(2)?;
                let qty: i64 = r.get(3)?;
                let price: i64 = r.get(4)?;
                let unit_type: String = r.get(5)?;
                let line_discount: i64 = r.get(6)?;
                let shade_note: Option<String> = r.get(7)?;
                let line_order: i64 = r.get(8)?;
                c.execute(
                    "INSERT INTO sale_items
                    (sale_id,kind,item_id,formula_id,qty,price,unit_type,line_discount,shade_note,line_order)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                    params![
                        new_id,
                        kind,
                        item_id,
                        formula_id,
                        qty,
                        price,
                        unit_type,
                        line_discount,
                        shade_note,
                        line_order
                    ],
                )?;
                // Stock movements for real items AND formulas with a linked base item.
                if let Some(item_id) = item_id {
                    let available: i64 = c.query_row(
                        "SELECT COALESCE(qty, 0) FROM stock_balances WHERE item_id = ?1 AND location_id = ?2",
                        params![item_id, default_location],
                        |r| r.get(0),
                    ).unwrap_or(0);
                    if available < qty {
                        let item_name: String = c.query_row(
                            "SELECT name FROM items WHERE id = ?1",
                            params![item_id],
                            |r| r.get(0),
                        ).unwrap_or_else(|_| "unknown".into());
                        return Err(SaleError::InsufficientStock { item_id, item_name, available, requested: qty });
                    }
                    c.execute(
                        "INSERT INTO stock_movements
                        (item_id,location_id,qty,kind_id,unit_id,ref_kind,ref_id,created_by,created_at)
                     VALUES (?1,?2,?3,(SELECT id FROM stock_movement_kinds WHERE code='sale'),(SELECT unit_id FROM items WHERE id=?1),'sale',?4,?5,?6)",
                        params![item_id, default_location, -qty, new_id, user_id, now()],
                    )?;
                } else if kind == "formula" {
                    if let Some(fid) = formula_id {
                        let base_item_id: Option<i64> = c.query_row(
                            "SELECT base_item_id FROM formulas WHERE id = ?1",
                            params![fid],
                            |r| r.get(0),
                        ).unwrap_or(None);
                        if let Some(base_id) = base_item_id {
                            let available: i64 = c.query_row(
                                "SELECT COALESCE(qty, 0) FROM stock_balances WHERE item_id = ?1 AND location_id = ?2",
                                params![base_id, default_location],
                                |r| r.get(0),
                            ).unwrap_or(0);
                            if available < qty {
                                let item_name: String = c.query_row(
                                    "SELECT name FROM items WHERE id = ?1",
                                    params![base_id],
                                    |r| r.get(0),
                                ).unwrap_or_else(|_| "unknown".into());
                                return Err(SaleError::InsufficientStock { item_id: base_id, item_name, available, requested: qty });
                            }
                            c.execute(
                                "INSERT INTO stock_movements
                                (item_id,location_id,qty,kind_id,unit_id,ref_kind,ref_id,created_by,created_at)
                             VALUES (?1,?2,?3,(SELECT id FROM stock_movement_kinds WHERE code='sale'),(SELECT unit_id FROM items WHERE id=?1),'sale',?4,?5,?6)",
                                params![base_id, default_location, -qty, new_id, user_id, now()],
                            )?;
                        }
                    }
                }
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

pub fn list(db: &Db, status: Option<&str>, limit: i64) -> anyhow::Result<Vec<Sale>> {
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
        "SELECT si.kind, si.item_id, si.formula_id,
                COALESCE(i.name, f.id_code, '') AS display_name,
                si.qty, si.price, si.unit_type, si.line_discount,
                si.shade_note, si.line_order
         FROM sale_items si
         LEFT JOIN items i ON i.id = si.item_id
         LEFT JOIN formulas f ON f.id = si.formula_id
         WHERE si.sale_id = ?1
         ORDER BY si.line_order",
    )?;
    let rows = stmt.query_map(params![sale_id], |r| {
        Ok(SaleItem {
            kind: r.get(0)?,
            item_id: r.get(1)?,
            formula_id: r.get(2)?,
            display_name: r.get(3)?,
            qty: r.get(4)?,
            price: r.get(5)?,
            unit_type: r.get(6)?,
            line_discount: r.get(7)?,
            shade_note: r.get(8)?,
            line_order: r.get(9)?,
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
// Tauri command surface.
// -----------------------------------------------------------------------------

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
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
        k => Err(AppError::Validation(format!(
            "invalid kind: {} (expected 'quotation' or 'final')",
            k
        ))),
    }
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
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

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_get_sale(state: tauri::State<'_, AppState>, id: i64) -> AppResult<Option<Sale>> {
    ipc_auth::authorize_err("cmd_get_sale", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    get(db, id).map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
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

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_list_sales(
    state: tauri::State<'_, AppState>,
    status: Option<String>,
    limit: Option<i64>,
) -> AppResult<Vec<Sale>> {
    ipc_auth::authorize_err("cmd_list_sales", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    list(db, status.as_deref(), limit.unwrap_or(100)).map_err(|e| AppError::Internal(e.to_string()))
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
// Sale returns (RET/...) — owner-PIN-gated, atomic.
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct CreateSaleReturnPayload {
    pub sale_id: i64,
    pub date: Option<String>,
    pub reason: Option<String>,
    pub payment_modes: Vec<PaymentSplit>,
    pub owner_pin: String,
    pub lines: Vec<CreateSaleReturnLine>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateSaleReturnLine {
    pub sale_item_id: i64,
    pub qty: i64,
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
    pub qty: i64,
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
        requested: i64,
        already: i64,
        sold: i64,
    },
    #[error("payment_modes sum ({got}) must equal refund total ({want})")]
    ModesSumMismatch { got: i64, want: i64 },
    #[error("sale {0} not found")]
    SaleNotFound(i64),
    #[error("sale {0} is not a final bill (status: {1})")]
    NotAFinalSale(i64, String),
    #[error("db error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("{0}")]
    Other(#[from] anyhow::Error),
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
        if l.qty <= 0 {
            return Err(ReturnError::BadLineQty(i));
        }
        if l.refund_paise < 0 {
            return Err(ReturnError::BadRefund(i));
        }
    }

    let new_id = db.with_conn_immediate(|c| -> Result<i64, ReturnError> {
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

        // Per-line validation: each sale_item_id must belong to the original
        // sale AND requested qty must not exceed (sold - already_returned).
        for (i, l) in payload.lines.iter().enumerate() {
            let (sale_id_of_item, sold_qty): (i64, i64) = c
                .query_row(
                    "SELECT sale_id, qty FROM sale_items WHERE id = ?1",
                    params![l.sale_item_id],
                    |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
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
            let already: i64 = c.query_row(
                "SELECT COALESCE(SUM(qty), 0) FROM sale_return_lines
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

        let refund_total: i64 = payload
            .lines
            .iter()
            .map(|l| l.qty.saturating_mul(l.refund_paise))
            .sum();
        let modes_sum: i64 = payload.payment_modes.iter().map(|m| m.amount).sum();
        if modes_sum != refund_total {
            return Err(ReturnError::ModesSumMismatch {
                got: modes_sum,
                want: refund_total,
            });
        }

        // Default location: lowest active location id (mirrors create_final_bill).
        let default_location: i64 = c.query_row(
            "SELECT id FROM locations WHERE is_active = 1 ORDER BY id LIMIT 1",
            [],
            |r| r.get(0),
        )?;

        let no = sequences::mint_next_sale_no(db, sequences::Kind::SaleRet)
            .map_err(ReturnError::Other)?;
        let logical_date = payload.date.unwrap_or_else(today);
        let created_at = now();
        let reason = payload.reason.clone();

        let return_id: i64 = c.query_row(
            "INSERT INTO sale_returns
                (no, sale_id, refund_total_paise, reason, created_at, created_by)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             RETURNING id",
            params![
                no,
                payload.sale_id,
                refund_total,
                reason,
                logical_date,
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
            // Positive stock movement (return restores stock).
            let item_id = sale_item_id_to_item_id(c, l.sale_item_id)?;
            c.execute(
                "INSERT INTO stock_movements
                    (item_id,location_id,qty,kind_id,unit_id,ref_kind,ref_id,created_by,created_at)
                 VALUES (?1,?2,?3,(SELECT id FROM stock_movement_kinds WHERE code='return'),(SELECT unit_id FROM items WHERE id=?1),'return',?4,?5,?6)",
                params![
                    item_id,
                    default_location,
                    l.qty,
                    return_id,
                    user_id,
                    created_at,
                ],
            )?;
        }

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

        // Refund reduces the customer's paid amount on the original sale so
        // the outstanding ledger stays correct. Floors at 0 — a return can
        // never make paid_amount negative.
        c.execute(
            "UPDATE sales
             SET paid_amount = MAX(0, paid_amount - ?1)
             WHERE id = ?2",
            params![refund_total, payload.sale_id],
        )?;

        Ok(return_id)
    })?;
    Ok(new_id)
}

fn sale_item_id_to_item_id(
    c: &rusqlite::Connection,
    sale_item_id: i64,
) -> Result<i64, ReturnError> {
    Ok(c.query_row(
        "SELECT item_id FROM sale_items WHERE id = ?1",
        params![sale_item_id],
        |r| r.get(0),
    )?)
}

fn row_to_sale_return(
    c: &rusqlite::Connection,
    header: &SaleReturnHeader,
) -> AppResult<SaleReturn> {
    let mut stmt = c.prepare(
        "SELECT sil.sale_item_id, COALESCE(i.name, ''), sil.qty, sil.refund_paise, sil.shade_note
         FROM sale_return_lines sil
         LEFT JOIN items i ON i.id = (
             SELECT si.item_id FROM sale_items si WHERE si.id = sil.sale_item_id
         )
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

struct SaleReturnHeader {
    id: i64,
    no: String,
    sale_id: i64,
    date: String,
    reason: Option<String>,
    refund_total: i64,
    created_at: String,
    created_by: i64,
}

fn fetch_return_header(c: &rusqlite::Connection, id: i64) -> AppResult<Option<SaleReturnHeader>> {
    let row = c
        .query_row(
            "SELECT id, COALESCE(no, ''), sale_id, created_at, reason, refund_total_paise, created_by
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
                    created_at: r.get(3)?,
                    created_by: r.get(6)?,
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
            "SELECT sr.id, COALESCE(sr.no, ''), sr.sale_id, sr.created_at, sr.reason,
                    sr.refund_total_paise, sr.created_at, sr.created_by
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
            sql.push_str(&format!(" AND sr.created_at >= ?{}", bound.len() + 1));
            bound.push(Box::new(d.to_string()));
        }
        if let Some(d) = to_date {
            sql.push_str(&format!(" AND sr.created_at <= ?{}", bound.len() + 1));
            bound.push(Box::new(d.to_string()));
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

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
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
    create_sale_return(db, user_id, payload).map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
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

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
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
        limit.unwrap_or(100),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(qty: f64, price: i64, disc: i64) -> CartLine {
        CartLine {
            kind: "item".into(),
            item_id: Some(1),
            formula_id: None,
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
            customer_type_id: None,
            type_name: None,
            is_flagged: false,
            opening_balance_paise: 0,
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
            PaymentSplit {
                mode: "cash".into(),
                amount: 500,
            },
            PaymentSplit {
                mode: "upi".into(),
                amount: 500,
            },
        ];
        assert_eq!(modes_sum(&modes), 1000);
    }

    fn ret_line(sale_item_id: i64, qty: i64, refund_paise: i64) -> CreateSaleReturnLine {
        CreateSaleReturnLine {
            sale_item_id,
            qty,
            refund_paise,
            shade_note: None,
        }
    }

    #[test]
    fn sale_return_rejects_empty_lines() {
        let db = Db::open_in_memory().unwrap();
        let payload = CreateSaleReturnPayload {
            sale_id: 1,
            date: None,
            reason: None,
            payment_modes: vec![PaymentSplit {
                mode: "cash".into(),
                amount: 0,
            }],
            owner_pin: String::new(),
            lines: vec![],
        };
        let err = create_sale_return(&db, 1, payload).unwrap_err();
        assert!(matches!(err, ReturnError::EmptyLines));
    }

    #[test]
    fn sale_return_rejects_zero_or_negative_qty() {
        let db = Db::open_in_memory().unwrap();
        let payload = CreateSaleReturnPayload {
            sale_id: 1,
            date: None,
            reason: None,
            payment_modes: vec![],
            owner_pin: String::new(),
            lines: vec![ret_line(10, 0, 100)],
        };
        let err = create_sale_return(&db, 1, payload).unwrap_err();
        assert!(matches!(err, ReturnError::BadLineQty(0)));
    }

    #[test]
    fn sale_return_rejects_negative_refund() {
        let db = Db::open_in_memory().unwrap();
        let payload = CreateSaleReturnPayload {
            sale_id: 1,
            date: None,
            reason: None,
            payment_modes: vec![],
            owner_pin: String::new(),
            lines: vec![ret_line(10, 1, -10)],
        };
        let err = create_sale_return(&db, 1, payload).unwrap_err();
        assert!(matches!(err, ReturnError::BadRefund(0)));
    }

    #[test]
    fn sale_return_rejects_missing_sale() {
        let db = Db::open_in_memory().unwrap();
        let payload = CreateSaleReturnPayload {
            sale_id: 999, // not present
            date: None,
            reason: None,
            payment_modes: vec![PaymentSplit {
                mode: "cash".into(),
                amount: 100,
            }],
            owner_pin: String::new(),
            lines: vec![ret_line(1, 1, 100)],
        };
        let err = create_sale_return(&db, 1, payload).unwrap_err();
        assert!(matches!(err, ReturnError::SaleNotFound(999)));
    }

    #[test]
    fn sale_return_rejects_non_final_sale() {
        let db = Db::open_in_memory().unwrap();
        // Seed user and item so FKs are satisfied.
        db.with_raw(|c| {
            c.execute(
                "INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length, created_at, updated_at) \
                 VALUES ('test', 'owner', X'00', X'00', 6, 0, 0)",
                [],
            )
            .unwrap();
            c.execute(
                "INSERT INTO items (sku_code, name, unit_id, unit_code, unit_label, retail_price_paise, cost_paise, created_at, updated_at) \
                 VALUES ('SK001', 'Test Item', (SELECT id FROM units WHERE code='L' LIMIT 1), 'L', 'Liter', 100, 50, 0, 0)",
                [],
            )
            .unwrap();
        });
        // Seed a quotation (not a final sale) at id=1.
        db.with_raw(|c| {
            c.execute(
                "INSERT INTO sales (no, status, date, subtotal, bill_discount, total, paid_amount, user_id) \
                 VALUES ('QTN-X', 'quotation', '2025-01-01', 100, 0, 100, 0, 1)",
                [],
            )
            .unwrap();
        });
        let payload = CreateSaleReturnPayload {
            sale_id: 1,
            date: None,
            reason: None,
            payment_modes: vec![],
            owner_pin: String::new(),
            lines: vec![ret_line(1, 1, 100)],
        };
        let err = create_sale_return(&db, 1, payload).unwrap_err();
        assert!(matches!(err, ReturnError::NotAFinalSale(1, s) if s == "quotation"));
    }

    #[test]
    fn sale_return_rejects_modes_sum_mismatch() {
        let db = Db::open_in_memory().unwrap();
        // Seed user and item so FKs are satisfied.
        db.with_raw(|c| {
            c.execute(
                "INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length, created_at, updated_at) \
                 VALUES ('test', 'owner', X'00', X'00', 6, 0, 0)",
                [],
            )
            .unwrap();
            c.execute(
                "INSERT INTO items (sku_code, name, unit_id, unit_code, unit_label, retail_price_paise, cost_paise, created_at, updated_at) \
                 VALUES ('SK001', 'Test Item', (SELECT id FROM units WHERE code='L' LIMIT 1), 'L', 'Liter', 100, 50, 0, 0)",
                [],
            )
            .unwrap();
        });
        // Seed a final sale with one item.
        db.with_raw(|c| {
            c.execute(
                "INSERT INTO sales (no, status, date, subtotal, bill_discount, total, paid_amount, user_id) \
                 VALUES ('INV-X', 'final', '2025-01-01', 100, 0, 100, 100, 1)",
                [],
            )
            .unwrap();
            c.execute(
                "INSERT INTO sale_items (sale_id, item_id, qty, price, unit_type, line_discount, line_order) \
                 VALUES (1, 1, 10, 10, 'unit', 0, 0)",
                [],
            )
            .unwrap();
        });
        // 2 items * 10 paise refund = 20, but we provide only 10 in payment_modes.
        let payload = CreateSaleReturnPayload {
            sale_id: 1,
            date: None,
            reason: None,
            payment_modes: vec![PaymentSplit {
                mode: "cash".into(),
                amount: 10,
            }],
            owner_pin: String::new(),
            lines: vec![ret_line(1, 2, 10)],
        };
        let err = create_sale_return(&db, 1, payload).unwrap_err();
        match err {
            ReturnError::ModesSumMismatch { got, want } => {
                assert_eq!(got, 10);
                assert_eq!(want, 20);
            }
            other => panic!("expected ModesSumMismatch, got {other:?}"),
        }
    }
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_edit_sale(
    state: tauri::State<'_, AppState>,
    _sale_id: i64,
    _payload: serde_json::Value,
) -> AppResult<i64> {
    ipc_auth::authorize_err("cmd_edit_sale", state.inner())?;
    Err(AppError::Internal("not implemented".into()))
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_list_sale_payments(
    state: tauri::State<'_, AppState>,
    _sale_id: i64,
) -> AppResult<Vec<serde_json::Value>> {
    ipc_auth::authorize_err("cmd_list_sale_payments", state.inner())?;
    Ok(Vec::new())
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_record_sale_payment(
    state: tauri::State<'_, AppState>,
    _sale_id: i64,
    _amount: i64,
    _mode: String,
    _date: Option<String>,
) -> AppResult<i64> {
    ipc_auth::authorize_err("cmd_record_sale_payment", state.inner())?;
    Err(AppError::Internal("not implemented".into()))
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_void_sale(
    state: tauri::State<'_, AppState>,
    _sale_id: i64,
    _pin: String,
) -> AppResult<()> {
    ipc_auth::authorize_err("cmd_void_sale", state.inner())?;
    Err(AppError::Internal("not implemented".into()))
}

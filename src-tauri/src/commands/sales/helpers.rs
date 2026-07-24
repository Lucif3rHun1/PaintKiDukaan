//! Shared sales types, cart math, row mappers, and stock helpers.
use chrono::{Local, NaiveDate};
use rusqlite::params;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use crate::commands::_stock_movements::{insert_stock_movement, StockMovementKind};
use crate::commands::customers;
use crate::error::AppError;

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
    pub id: i64, // sale_items primary key (for returns FK)
    pub kind: String, // "item" | "formula"
    pub item_id: Option<i64>,
    pub formula_id: Option<i64>,
    pub display_name: String,
    pub sku_code: Option<String>,
    pub qty: f64,
    pub price: i64,
    pub unit_type: String, // "pcs" | "mtr" | "kg"
    pub line_discount: i64,
    pub shade_note: Option<String>,
    pub line_order: i64,
    /// Aggregated qty already returned across all prior returns for this
    /// sale_item. Computed via LEFT JOIN to sale_return_lines. Defaults to 0
    /// when no returns exist. Use `qty - returned_qty` for refundable headroom.
    #[serde(default)]
    pub returned_qty: f64,
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
    pub display_name: Option<String>,
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
    #[error("invalid kind: {0} (expected 'quotation', 'final', or 'fbill')")]
    InvalidKind(String),
    #[error("insufficient stock for item '{item_name}' (id={item_id}): available {available}, need {requested}")]
    InsufficientStock {
        item_id: i64,
        item_name: String,
        available: f64,
        requested: f64,
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
            SaleError::InsufficientStock {
                item_name,
                available,
                requested,
                ..
            } => {
                let avail = available.max(0.0);
                AppError::Validation(format!(
                    "Not enough stock for '{item_name}'. Only {avail:.1} available, you need {requested:.1}."
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
    lines.iter().fold(0i64, |acc, l| acc.saturating_add(line_value(l)))
}

pub fn cart_total(lines: &[CartLine], bill_discount: i64) -> i64 {
    (cart_subtotal(lines) - bill_discount).max(0)
}

/// Per-line preview values returned to the frontend. `line_value_paise` is the
/// GROSS line value (`round(qty × price)`); `line_subtotal_paise` is the NET
/// value after subtracting the line discount, floored at zero.
#[derive(Debug, Clone, Serialize)]
pub struct CartPreviewLine {
    pub line_value_paise: i64,
    pub line_subtotal_paise: i64,
}

/// Authoritative cart totals computed by Rust's `line_value` / `cart_subtotal`
/// / `cart_total`. Used by the frontend for read-only previewing so the UI
/// cannot drift from the formulas Rust will apply when persisting the sale.
#[derive(Debug, Clone, Serialize)]
pub struct CartPreview {
    pub lines: Vec<CartPreviewLine>,
    pub cart_subtotal_paise: i64,
    pub cart_total_paise: i64,
    pub bill_discount_paise: i64,
}

/// Pure cart math exposed as a Tauri command so the frontend can render
/// authoritative totals without duplicating the formula. No DB access; safe
/// to call as often as the UI needs.
#[tauri::command(rename_all = "snake_case")]
pub fn cmd_preview_cart_total(lines: Vec<CartLine>, bill_discount: i64) -> CartPreview {
    let preview_lines = lines
        .iter()
        .map(|l| CartPreviewLine {
            line_value_paise: (l.qty * l.price as f64).round() as i64,
            line_subtotal_paise: line_value(l),
        })
        .collect();
    let subtotal = cart_subtotal(&lines);
    CartPreview {
        lines: preview_lines,
        cart_subtotal_paise: subtotal,
        cart_total_paise: (subtotal - bill_discount).max(0),
        bill_discount_paise: bill_discount,
    }
}

pub fn modes_sum(modes: &[PaymentSplit]) -> i64 {
    modes.iter().fold(0i64, |acc, m| acc.saturating_add(m.amount))
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

pub(crate) fn load_items(c: &rusqlite::Connection, sale_id: i64) -> anyhow::Result<Vec<SaleItem>> {
    let mut stmt = c.prepare(
        "SELECT si.id, si.kind, si.item_id, si.formula_id,
                COALESCE(si.display_name, COALESCE(b.name || ' · ' || i.name, i.name), f.id_code, '') AS display_name,
                i.sku_code,
                si.qty, si.price, si.unit_type, si.line_discount,
                si.shade_note, si.line_order,
                COALESCE((SELECT SUM(srl.qty) FROM sale_return_lines srl
                          WHERE srl.sale_item_id = si.id), 0.0) AS returned_qty
         FROM sale_items si
         LEFT JOIN items i ON i.id = si.item_id
         LEFT JOIN brands b ON b.id = i.brand_id
         LEFT JOIN formulas f ON f.id = si.formula_id
         WHERE si.sale_id = ?1
         ORDER BY si.line_order",
    )?;
    let rows = stmt.query_map(params![sale_id], |r| {
        Ok(SaleItem {
            id: r.get(0)?,
            kind: r.get(1)?,
            item_id: r.get(2)?,
            formula_id: r.get(3)?,
            display_name: r.get(4)?,
            sku_code: r.get(5)?,
            qty: r.get(6)?,
            price: r.get(7)?,
            unit_type: r.get(8)?,
            line_discount: r.get(9)?,
            shade_note: r.get(10)?,
            line_order: r.get(11)?,
            returned_qty: r.get(12)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub(crate) fn row_to_sale_header(r: &rusqlite::Row<'_>) -> rusqlite::Result<Sale> {
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

/// Like `row_to_sale_header` but reads customer_name from column 14
/// (LEFT JOIN customers). Avoids N+1 per-row customer lookups.
pub(crate) fn row_to_sale_header_with_name(r: &rusqlite::Row<'_>) -> rusqlite::Result<Sale> {
    let modes_json: String = r.get(9)?;
    let modes: Vec<PaymentSplit> = serde_json::from_str(&modes_json).unwrap_or_default();
    let cname: String = r.get(14)?;
    Ok(Sale {
        id: r.get(0)?,
        no: r.get(1)?,
        customer_id: r.get(2)?,
        customer_name: if cname.is_empty() { None } else { Some(cname) },
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
// helpers
// -----------------------------------------------------------------------------

pub(crate) fn today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

/// Interprets input as local date (midnight in runtime TZ).
/// For UTC semantics, call `Local::now()` directly.
pub(crate) fn date_to_ms(date: &str) -> i64 {
    NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .and_then(|t| t.and_local_timezone(Local).single())
        .map(|dt| dt.timestamp_millis())
        .unwrap_or_else(now_epoch_ms)
}

pub(crate) fn now_epoch_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}


// -----------------------------------------------------------------------------
// Stock deduction (item line or formula base item).
// -----------------------------------------------------------------------------

pub struct StockLineRef<'a> {
    pub kind: &'a str,
    pub item_id: Option<i64>,
    pub formula_id: Option<i64>,
    pub qty: f64,
}

impl<'a> From<&'a CartLine> for StockLineRef<'a> {
    fn from(l: &'a CartLine) -> Self {
        Self { kind: l.kind.as_str(), item_id: l.item_id, formula_id: l.formula_id, qty: l.qty }
    }
}

pub fn deduct_stock_for_line(
    tx: &rusqlite::Connection,
    line: StockLineRef<'_>,
    default_location: i64,
    sale_id: i64,
    user_id: i64,
) -> Result<(), SaleError> {
    if let Some(item_id) = line.item_id {
        let requested = line.qty;
        let available: f64 = tx
            .query_row(
                "SELECT COALESCE(SUM(qty), 0.0) FROM stock_balances WHERE item_id = ?1",
                params![item_id], |r| r.get(0),
            )
            .unwrap_or(0.0);
        if available < requested {
            let item_name: String = tx
                .query_row(
                    "SELECT COALESCE(b.name || ' · ' || i.name, i.name) FROM items i LEFT JOIN brands b ON b.id = i.brand_id WHERE i.id = ?1",
                    params![item_id], |r| r.get(0),
                )
                .unwrap_or_else(|_| "unknown".into());
            return Err(SaleError::InsufficientStock { item_id, item_name, available, requested });
        }
        insert_stock_movement(tx, item_id, default_location, -requested,
            StockMovementKind::Sale, Some(sale_id), None, now_epoch_ms(), user_id)?;
    } else if line.kind == "formula" {
        if let Some(fid) = line.formula_id {
            let base_item_id: Option<i64> = tx
                .query_row("SELECT base_item_id FROM formulas WHERE id = ?1", params![fid], |r| r.get(0))
                .optional()?;
            if let Some(base_id) = base_item_id {
                let requested = line.qty;
                let available: f64 = tx
                    .query_row("SELECT COALESCE(SUM(qty), 0.0) FROM stock_balances WHERE item_id = ?1",
                        params![base_id], |r| r.get(0))
                    .unwrap_or(0.0);
                if available < requested {
                    let item_name: String = tx
                        .query_row(
                            "SELECT COALESCE(b.name || ' · ' || i.name, i.name) FROM items i LEFT JOIN brands b ON b.id = i.brand_id WHERE i.id = ?1",
                            params![base_id], |r| r.get(0),
                        )
                        .unwrap_or_else(|_| "unknown".into());
                    return Err(SaleError::InsufficientStock { item_id: base_id, item_name, available, requested });
                }
                insert_stock_movement(tx, base_id, default_location, -requested,
                    StockMovementKind::Sale, Some(sale_id), None, now_epoch_ms(), user_id)?;
            }
        }
    }
    Ok(())
}

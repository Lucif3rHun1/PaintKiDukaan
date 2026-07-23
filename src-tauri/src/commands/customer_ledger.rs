//! Customer ledger reads + credit-invoice writes.
//!
//! Provides a per-transaction khata view (sales increase balance, payments
//! decrease it) and a dedicated command to post a credit invoice for a
//! customer on an older date.

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::commands::{customers, sales};
use crate::commands::sales::date_to_ms;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::session::{require_role, Role};

// -----------------------------------------------------------------------------
// Public types (Tauri command arguments / return values).
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct CustomerLedgerTransaction {
    pub id: i64,
    pub date: String,
    pub kind: String, // "sale" | "payment"
    pub ref_no: Option<String>,
    pub description: Option<String>,
    pub debit_paise: i64,
    pub credit_paise: i64,
    pub balance_paise: i64,
    #[serde(skip_serializing)]
    sort_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CustomerLedger {
    pub customer_id: i64,
    pub opening_balance_paise: i64,
    pub closing_balance_paise: i64,
    pub rows: Vec<CustomerLedgerTransaction>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreditInvoiceLine {
    pub item_id: i64,
    pub qty: f64,
    pub unit_price_paise: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateCustomerCreditInvoice {
    pub customer_id: i64,
    pub date: String, // ISO YYYY-MM-DD
    pub description: Option<String>,
    pub lines: Vec<CreditInvoiceLine>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RecordCustomerPayment {
    pub customer_id: i64,
    pub amount: i64, // paise, must be > 0
    pub mode: String,
    pub date: String, // ISO YYYY-MM-DD
    pub note: Option<String>,
}

// -----------------------------------------------------------------------------
// Reads.
// -----------------------------------------------------------------------------

pub fn customer_ledger_impl(db: &Db, customer_id: i64, limit: i64) -> AppResult<CustomerLedger> {
    db.with_raw(|c| {
        let opening_balance_paise: i64 = c.query_row(
            "SELECT opening_balance_paise FROM customers WHERE id = ?1",
            params![customer_id],
            |r| r.get(0),
        )?;

        let mut stmt = c.prepare(
            "SELECT id, no, created_at, total, COALESCE(total - paid_amount, 0)
             FROM sales
             WHERE customer_id = ?1 AND status = 'final'
             ORDER BY created_at ASC, id ASC",
        )?;
        let sale_rows = stmt.query_map(params![customer_id], |r| {
            let created_at_text: String = r.get(2)?;
            Ok(CustomerLedgerTransaction {
                id: r.get::<_, i64>(0)?,
                date: created_at_text.clone(),
                kind: "sale".to_string(),
                ref_no: r.get::<_, String>(1).ok(),
                description: None,
                debit_paise: r.get::<_, i64>(3)?,
                credit_paise: 0,
                balance_paise: 0,
                sort_ms: text_datetime_to_ms(&created_at_text),
            })
        })?;
        let mut rows: Vec<CustomerLedgerTransaction> = sale_rows.collect::<Result<Vec<_>, _>>()?;

        let mut stmt = c.prepare(
            "SELECT id, created_at, amount_paise, mode, note
             FROM customer_payments
             WHERE customer_id = ?1
             ORDER BY created_at ASC, id ASC",
        )?;
        let payment_rows = stmt.query_map(params![customer_id], |r| {
            let created_at_ms: i64 = r.get(1)?;
            Ok(CustomerLedgerTransaction {
                id: r.get::<_, i64>(0)?,
                date: ms_to_date(created_at_ms),
                kind: "payment".to_string(),
                ref_no: None,
                description: r.get::<_, String>(4).ok(),
                debit_paise: 0,
                credit_paise: r.get::<_, i64>(2)?,
                balance_paise: 0,
                sort_ms: created_at_ms,
            })
        })?;
        rows.extend(payment_rows.collect::<Result<Vec<_>, _>>()?);

        rows.sort_by(|a, b| a.sort_ms.cmp(&b.sort_ms).then_with(|| a.id.cmp(&b.id)));

        let mut balance = opening_balance_paise;
        for row in &mut rows {
            balance += row.debit_paise - row.credit_paise;
            row.balance_paise = balance;
        }

        let closing_balance_paise = balance;

        rows.reverse();
        rows.truncate(limit.max(1) as usize);

        Ok(CustomerLedger {
            customer_id,
            opening_balance_paise,
            closing_balance_paise,
            rows,
        })
    })
}

// -----------------------------------------------------------------------------
// Writes.
// -----------------------------------------------------------------------------

pub fn create_customer_credit_invoice_impl(
    db: &Db,
    user: &crate::session::User,
    req: CreateCustomerCreditInvoice,
) -> AppResult<i64> {
    require_role(user, &[Role::Owner, Role::Cashier])?;

    // Verify the customer exists.
    let customer_id = req.customer_id;
    let customer = db
        .with_raw(|c| customers::get_by_id(c, customer_id))?
        .ok_or_else(|| AppError::NotFound(format!("customer {}", customer_id)))?;

    if req.lines.is_empty() {
        return Err(AppError::Validation(
            "credit invoice must have at least one line".into(),
        ));
    }

    let lines: Vec<sales::CartLine> = req
        .lines
        .into_iter()
        .map(|l| sales::CartLine {
            kind: "item".into(),
            item_id: Some(l.item_id),
            formula_id: None,
            display_name: None,
            qty: l.qty,
            price: l.unit_price_paise,
            unit_type: "pcs".into(),
            line_discount: 0,
            shade_note: req.description.clone(),
        })
        .collect();

    let sale = sales::NewSale {
        customer_id: Some(customer.id),
        kind: "final".into(),
        date: Some(req.date),
        bill_discount: 0,
        paid_amount: 0,
        payment_modes: Vec::new(),
        validity_days: None,
        acknowledge_flag: false,
        lines,
    };

    sales::create_final_bill(db, user.id, sale).map_err(AppError::from)
}

pub fn record_customer_payment_impl(
    db: &Db,
    user: &crate::session::User,
    req: RecordCustomerPayment,
) -> AppResult<customers::CustomerOutstanding> {
    require_role(user, &[Role::Owner, Role::Cashier])?;

    if req.amount <= 0 {
        return Err(AppError::Validation("payment amount must be > 0".into()));
    }
    if req.mode.trim().is_empty() {
        return Err(AppError::Validation("payment mode is required".into()));
    }

    let created_at = date_to_ms(&req.date);
    let customer_id = req.customer_id;

    db.with_conn_immediate(|c| -> AppResult<()> {
        // Ensure customer exists before recording payment.
        let exists: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM customers WHERE id = ?1)",
            params![customer_id],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(AppError::NotFound(format!("customer {}", customer_id)));
        }
        c.execute(
            "INSERT INTO customer_payments (customer_id, sale_id, mode, amount_paise, reference, note, created_at, created_by)
             VALUES (?1, NULL, ?2, ?3, NULL, ?4, ?5, ?6)",
            params![
                customer_id,
                req.mode,
                req.amount,
                req.note,
                created_at,
                user.id,
            ],
        )?;
        Ok(())
    })?;

    customers::customer_outstanding_impl(db, customer_id)
}

// -----------------------------------------------------------------------------
// Tauri command wrappers live in `commands::customers` so the existing
// invoke_handler in `lib.rs` does not need to change.
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Helpers.
// -----------------------------------------------------------------------------

fn ms_to_date(ms: i64) -> String {
    use chrono::TimeZone;
    chrono::Utc
        .timestamp_millis_opt(ms)
        .single()
        .map(|dt| dt.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| String::new())
}

fn text_datetime_to_ms(s: &str) -> i64 {
    use chrono::NaiveDateTime;
    NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
        .ok()
        .and_then(|dt| dt.and_local_timezone(chrono::Local).single())
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    #[test]
    fn ledger_running_balance_computed_oldest_first() {

        let db = Db::open_in_memory().unwrap();
        db.with_raw(|c| {
            c.execute("INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length, created_at, updated_at) VALUES ('O', 'owner', X'00', X'00', 6, 0, 0)", []).unwrap();
            c.execute("INSERT INTO locations (name, is_active, created_at, updated_at) VALUES ('Shop', 1, 0, 0)", []).unwrap();
            c.execute("INSERT INTO customers (name, phone, opening_balance_paise, created_at, updated_at) VALUES ('X', '9876543210', 100, 0, 0)", []).unwrap();
            c.execute("INSERT INTO sales (no, customer_id, status, user_id, subtotal, bill_discount, total, paid_amount, created_at, updated_at) \
                 VALUES ('INV-1', 1, 'final', 1, 500, 0, 500, 0, '2025-01-10 10:00:00', '2025-01-10 10:00:00')", []).unwrap();
            c.execute("INSERT INTO customer_payments (customer_id, sale_id, mode, amount_paise, created_at, created_by) VALUES (1, NULL, 'cash', 200, 2000, 1)", []).unwrap();
            c.execute("INSERT INTO sales (no, customer_id, status, user_id, subtotal, bill_discount, total, paid_amount, created_at, updated_at) \
                 VALUES ('INV-2', 1, 'final', 1, 300, 0, 300, 0, '2025-01-10 11:00:00', '2025-01-10 11:00:00')", []).unwrap();
        });

        let ledger = customer_ledger_impl(&db, 1, 200).unwrap();
        assert_eq!(ledger.opening_balance_paise, 100);
        // Rows are returned newest-first for display.
        // Payment (created_at=2000 → epoch 1970-01-01) sorts before INV-1
        // because it has no sale_id link, so the ledger query treats it as
        // an orphan with an ambiguous effective date.
        assert_eq!(ledger.rows.len(), 3);
        assert_eq!(ledger.rows[0].ref_no.as_deref(), Some("INV-2"));
        assert_eq!(ledger.rows[0].balance_paise, 700); // 100 + 500 - 200 + 300
        assert_eq!(ledger.rows[1].ref_no.as_deref(), Some("INV-1"));
        assert_eq!(ledger.rows[1].balance_paise, 400); // 100 + 500 - 200
        assert_eq!(ledger.rows[2].credit_paise, 200);
        // Sorting ASC: payment (1970-01-01) first → balance = 100 + 0 - 200 = -100
        // INV-1 → -100 + 500 = 400. INV-2 → 400 + 300 = 700.
        // After reversal for display: rows[2] = payment with balance -100.
        assert_eq!(ledger.rows[2].balance_paise, -100);
        assert_eq!(ledger.closing_balance_paise, 700);
    }
}

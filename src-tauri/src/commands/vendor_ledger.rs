//! Vendor ledger: outstanding, payments, and credit-invoice stubs.
//!
//! Mirrors `customer_ledger.rs` but for vendor-side accounts:
//! `opening_balance + Σ(purchases) - Σ(payments) = outstanding`.

use rusqlite::params;
use tauri::State;

use crate::commands::auth::AppState;
use crate::commands::sales::date_to_ms;
use crate::commands::vendors;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::security::ipc_auth;
use crate::session::{require_auth, require_role, Role};

// -----------------------------------------------------------------------------
// Outstanding balance (impl + Tauri command).
// -----------------------------------------------------------------------------

pub fn vendor_outstanding_impl(
    db: &Db,
    id: i64,
) -> AppResult<vendors::VendorOutstanding> {
    db.with_raw(|c| {
        let opening_balance: i64 = c.query_row(
            "SELECT COALESCE(opening_balance_paise, 0) FROM vendors WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        let total_purchases: i64 = c.query_row(
            "SELECT COALESCE(SUM(total_paise), 0) FROM purchases WHERE vendor_id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        let total_payments: i64 = c.query_row(
            "SELECT COALESCE(SUM(amount_paise), 0) FROM vendor_payments WHERE vendor_id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        let outstanding = opening_balance + total_purchases - total_payments;
        Ok(vendors::VendorOutstanding {
            vendor_id: id,
            opening_balance,
            total_purchases,
            total_payments,
            outstanding,
        })
    })
}

pub fn compute_outstanding_tx(
    tx: &rusqlite::Connection,
    id: i64,
) -> AppResult<vendors::VendorOutstanding> {
    let opening_balance: i64 = tx.query_row(
        "SELECT COALESCE(opening_balance_paise, 0) FROM vendors WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )?;
    let total_purchases: i64 = tx.query_row(
        "SELECT COALESCE(SUM(total_paise), 0) FROM purchases WHERE vendor_id = ?1",
        params![id],
        |r| r.get(0),
    )?;
    let total_payments: i64 = tx.query_row(
        "SELECT COALESCE(SUM(amount_paise), 0) FROM vendor_payments WHERE vendor_id = ?1",
        params![id],
        |r| r.get(0),
    )?;
    let outstanding = opening_balance + total_purchases - total_payments;
    Ok(vendors::VendorOutstanding {
        vendor_id: id,
        opening_balance,
        total_purchases,
        total_payments,
        outstanding,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn vendor_outstanding(
    state: State<'_, AppState>,
    id: i64,
) -> AppResult<vendors::VendorOutstanding> {
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let user = require_auth("vendor_outstanding", state.inner())?;
    require_role(&user, &[Role::Owner, Role::Cashier])?;
    vendor_outstanding_impl(db, id)
}

// -----------------------------------------------------------------------------
// Tauri command wrappers.
// -----------------------------------------------------------------------------

#[tauri::command(rename_all = "snake_case")]
pub fn record_vendor_payment(
    state: State<'_, AppState>,
    payload: vendors::VendorPayment,
) -> AppResult<vendors::VendorOutstanding> {
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let user = require_auth("record_vendor_payment", state.inner())?;
    require_role(&user, &[Role::Owner])?;
    if payload.amount <= 0 {
        return Err(AppError::Validation("amount must be > 0".into()));
    }
    if payload.mode.trim().is_empty() {
        return Err(AppError::Validation("mode is required".into()));
    }
    let date_ms = date_to_ms(&payload.date);
    db.with_tx(|tx| {
        // Ensure vendor exists.
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM vendors WHERE id = ?1)",
            params![payload.vendor_id],
            |r| r.get(0),
        ).unwrap_or(false);
        if !exists {
            return Err(AppError::NotFound(format!("vendor {}", payload.vendor_id)));
        }
        tx.execute(
            "INSERT INTO vendor_payments (vendor_id, purchase_id, mode, amount_paise, reference, note, created_at, created_by) VALUES (?1, NULL, ?2, ?3, NULL, ?4, ?5, ?6)",
            params![
                payload.vendor_id,
                payload.mode,
                payload.amount,
                payload.notes,
                date_ms,
                user.id,
            ],
        )?;
        compute_outstanding_tx(tx, payload.vendor_id)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn list_vendor_payments(
    state: State<'_, AppState>,
    _vendor_id: i64,
    _limit: Option<i64>,
) -> AppResult<Vec<serde_json::Value>> {
    ipc_auth::authorize_err("list_vendor_payments", state.inner())?;
    Ok(Vec::new())
}

#[tauri::command(rename_all = "snake_case")]
pub fn vendor_credit_sales(
    state: State<'_, AppState>,
    _vendor_id: i64,
) -> AppResult<Vec<serde_json::Value>> {
    ipc_auth::authorize_err("vendor_credit_sales", state.inner())?;
    Ok(Vec::new())
}

#[tauri::command(rename_all = "snake_case")]
pub fn create_vendor_credit_invoice(
    state: State<'_, AppState>,
    _vendor_id: i64,
    _payload: serde_json::Value,
) -> AppResult<()> {
    ipc_auth::authorize_err("create_vendor_credit_invoice", state.inner())?;
    // Stub: not yet implemented.
    Ok(())
}

// -----------------------------------------------------------------------------
// Tests.
// -----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    #[test]
    fn compute_outstanding_with_payment() {
        let db = Db::open_in_memory().unwrap();
        db.with_raw(|c| {
            c.execute("INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length, is_active, created_at, updated_at) VALUES ('O', 'owner', X'00', X'00', 6, 1, 0, 0)", []).unwrap();
            c.execute("INSERT INTO vendors (name, opening_balance_paise, is_active, created_at, updated_at) VALUES ('V', 0, 1, 0, 0)", []).unwrap();
            c.execute("INSERT INTO purchases (purchase_number, vendor_id, location_id, total_paise, created_by, created_at, updated_at) VALUES ('PINV-0001', 1, 1, 5000, 1, 0, 0)", []).unwrap();
            c.execute("INSERT INTO vendor_payments (vendor_id, purchase_id, mode, amount_paise, reference, note, created_at, created_by) VALUES (1, NULL, 'upi', 2000, NULL, NULL, 0, 1)", []).unwrap();
        });
        let out = vendor_outstanding_impl(&db, 1).unwrap();
        assert_eq!(out.total_purchases, 5000);
        assert_eq!(out.total_payments, 2000);
        assert_eq!(out.outstanding, 3000);
    }

    #[test]
    fn compute_outstanding_tx_with_payment() {
        let db = Db::open_in_memory().unwrap();
        db.with_raw(|c| {
            c.execute("INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length, is_active, created_at, updated_at) VALUES ('O', 'owner', X'00', X'00', 6, 1, 0, 0)", []).unwrap();
            c.execute("INSERT INTO vendors (name, opening_balance_paise, is_active, created_at, updated_at) VALUES ('V', 0, 1, 0, 0)", []).unwrap();
        });
        let out = db.with_tx(|tx| {
            tx.execute(
                "INSERT INTO vendor_payments (vendor_id, purchase_id, mode, amount_paise, reference, note, created_at, created_by) VALUES (1, NULL, 'cash', 100, NULL, NULL, 0, 1)",
                [],
            ).unwrap();
            compute_outstanding_tx(tx, 1)
        }).unwrap();
        assert_eq!(out.outstanding, -100);
    }
}

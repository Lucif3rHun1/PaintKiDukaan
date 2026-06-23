//! Sequence numbering for sale invoices, quotations, and sales returns.
//!
//! Per master plan §12, updated to per-day counters:
//!   - `INV/DD-MM-YYYY/001` for invoices
//!   - `QTN/DD-MM-YYYY/001` for quotations
//!   - `RET/DD-MM-YYYY/001` for sales returns
//!
//! Daily counters are stored in `daily_counters(prefix, date, last_serial)` and
//! the counter resets for each calendar day because the date is part of the
//! primary key. SKU numbering remains on the legacy `sequences` table with a
//! 5-digit global serial.
//!
//! Gap-aware (gaps are acceptable in v1; sequence is never reused).

use chrono::Local;

use crate::commands::auth::AppState;
use crate::db::Db;
use crate::error::{AppError, AppResult};

/// Kinds of sequence we mint. `Sku` is exposed so other commands can use the
/// same primitive (Slice B's item-create will need it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    SaleInv,
    SaleQtn,
    SaleRet,
    Sku,
}

impl Kind {
    fn as_seq_name(self) -> &'static str {
        match self {
            Kind::SaleInv => "sale_inv",
            Kind::SaleQtn => "sale_qtn",
            Kind::SaleRet => "sale_ret",
            Kind::Sku => "sku",
        }
    }

    /// Daily-counter row prefix used for INV/QTN/RET numbers.
    fn daily_prefix(self) -> &'static str {
        match self {
            Kind::SaleInv => "INV",
            Kind::SaleQtn => "QTN",
            Kind::SaleRet => "RET",
            Kind::Sku => "SKU",
        }
    }

    fn width(self) -> usize {
        match self {
            Kind::Sku => 5,
            // INV/QTN/RET all use 3-digit daily serials.
            _ => 3,
        }
    }
}

/// Mint the next number for `kind` and return it as a fully-formatted string.
///
/// Atomic increments of either `daily_counters` (INV/QTN/RET) or the legacy
/// `sequences` table (SKU), and reads it back.
pub fn mint_next(db: &Db, kind: Kind) -> anyhow::Result<String> {
    match kind {
        Kind::Sku => db.with_conn_immediate(|c| {
            let next: i64 = c.query_row(
                "INSERT INTO sequences(name,last_value)
                     VALUES (?1, 1)
                     ON CONFLICT(name) DO UPDATE
                       SET last_value = last_value + 1
                     RETURNING last_value",
                rusqlite::params![kind.as_seq_name()],
                |r| r.get(0),
            )?;
            Ok(format_number_sku(next))
        }),
        Kind::SaleInv | Kind::SaleQtn | Kind::SaleRet => {
            let date = today_ddmmyyyy();
            let date_for_closure = date.clone();
            db.with_conn_immediate(move |c| {
                let next: i64 = c.query_row(
                    "INSERT INTO daily_counters(prefix,date,last_serial)
                         VALUES (?1,?2,1)
                         ON CONFLICT(prefix,date) DO UPDATE
                           SET last_serial = last_serial + 1
                         RETURNING last_serial",
                    rusqlite::params![kind.daily_prefix(), &date_for_closure],
                    |r| r.get(0),
                )?;
                Ok(format_number_daily(kind, next, &date_for_closure))
            })
        }
    }
}

/// Mint only when the kind is sale-style (Invoice, Quotation, or Return). SKU
/// is exposed for symmetry but `mint_next_sale_no` is the helper Slice C uses
/// internally for sales + day-close rows.
pub fn mint_next_sale_no(db: &Db, kind: Kind) -> anyhow::Result<String> {
    match kind {
        Kind::SaleInv | Kind::SaleQtn | Kind::SaleRet => mint_next(db, kind),
        Kind::Sku => anyhow::bail!("mint_next_sale_no called with Sku"),
    }
}

fn format_number_daily(kind: Kind, n: i64, date: &str) -> String {
    let s = format!("{:0width$}", n, width = kind.width());
    format!("{}/{}/{}", kind.daily_prefix(), date, s)
}

fn format_number_sku(n: i64) -> String {
    format!("SKU-{:0>5}", n)
}

/// Parse a sale number and return the (kind, date, seq) triple. Currently
/// unused but kept for future validation paths (e.g. converting a quotation
/// to a final bill, looking up a return by `no`).
pub fn parse(no: &str) -> Option<(Kind, String, i64)> {
    let parts: Vec<&str> = no.splitn(3, '/').collect();
    if parts.len() != 3 {
        return None;
    }
    let (prefix, date, seq) = (parts[0], parts[1], parts[2]);
    let kind = match prefix {
        "INV" => Kind::SaleInv,
        "QTN" => Kind::SaleQtn,
        "RET" => Kind::SaleRet,
        _ => return None,
    };
    let seq: i64 = seq.parse().ok()?;
    Some((kind, date.to_string(), seq))
}

fn today_ddmmyyyy() -> String {
    Local::now().format("%d-%m-%Y").to_string()
}

// -----------------------------------------------------------------------------
// Tauri command surface.
// -----------------------------------------------------------------------------

fn resolve_kind(raw: &str) -> AppResult<Kind> {
    match raw {
        "inv" | "sale_inv" | "INV" => Ok(Kind::SaleInv),
        "qtn" | "sale_qtn" | "QTN" => Ok(Kind::SaleQtn),
        "ret" | "sale_ret" | "RET" => Ok(Kind::SaleRet),
        _ => Err(AppError::Internal(format!(
            "unknown sequence kind: {}",
            raw
        ))),
    }
}

fn lock_db<'a>(
    state: &'a tauri::State<'_, AppState>,
) -> AppResult<std::sync::MutexGuard<'a, Option<Db>>> {
    state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))
}

fn with_db<F, T>(state: &tauri::State<'_, AppState>, f: F) -> AppResult<T>
where
    F: FnOnce(&Db) -> anyhow::Result<T>,
{
    let guard = lock_db(state)?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    f(db).map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_mint_next_sale_no(state: tauri::State<'_, AppState>, kind: String) -> AppResult<String> {
    crate::security::ipc_auth::authorize_err("cmd_mint_next_sale_no", state.inner())?;
    let k = resolve_kind(&kind)?;
    with_db(&state, |db| {
        mint_next_sale_no(db, k).map_err(|e| anyhow::anyhow!("{}", e))
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_next_invoice_number(state: tauri::State<'_, AppState>) -> AppResult<String> {
    crate::security::ipc_auth::authorize_err("get_next_invoice_number", state.inner())?;
    with_db(&state, |db| {
        mint_next(db, Kind::SaleInv).map_err(|e| anyhow::anyhow!("{}", e))
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_next_quotation_number(state: tauri::State<'_, AppState>) -> AppResult<String> {
    crate::security::ipc_auth::authorize_err("get_next_quotation_number", state.inner())?;
    with_db(&state, |db| {
        mint_next(db, Kind::SaleQtn).map_err(|e| anyhow::anyhow!("{}", e))
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_next_return_number(state: tauri::State<'_, AppState>) -> AppResult<String> {
    crate::security::ipc_auth::authorize_err("get_next_return_number", state.inner())?;
    with_db(&state, |db| {
        mint_next(db, Kind::SaleRet).map_err(|e| anyhow::anyhow!("{}", e))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_number_daily_uses_three_digits() {
        let s = format_number_daily(Kind::SaleInv, 1, "23-06-2026");
        assert_eq!(s, "INV/23-06-2026/001");
    }

    #[test]
    fn format_number_sku_is_5_digits() {
        let s = format_number_sku(7);
        assert_eq!(s, "SKU-00007");
    }

    #[test]
    fn parse_round_trip() {
        let s = "INV/23-06-2026/042";
        let (k, d, n) = parse(s).unwrap();
        assert_eq!(k, Kind::SaleInv);
        assert_eq!(d, "23-06-2026");
        assert_eq!(n, 42);
        assert!(parse("garbage").is_none());
        assert!(parse("INV/23-06-2026").is_none());
    }

    #[test]
    fn mint_next_inv_is_daily_and_increments() {
        let db = Db::open_in_memory().unwrap();
        let a = mint_next(&db, Kind::SaleInv).unwrap();
        let b = mint_next(&db, Kind::SaleInv).unwrap();
        let c = mint_next(&db, Kind::SaleInv).unwrap();
        assert!(a.starts_with("INV/"));
        assert!(b.starts_with("INV/"));
        assert!(c.starts_with("INV/"));
        assert!(a.ends_with("/001"));
        assert!(b.ends_with("/002"));
        assert!(c.ends_with("/003"));
    }

    #[test]
    fn mint_inv_qtn_ret_independent_daily_counters() {
        let db = Db::open_in_memory().unwrap();
        let i = mint_next(&db, Kind::SaleInv).unwrap();
        let q = mint_next(&db, Kind::SaleQtn).unwrap();
        let r = mint_next(&db, Kind::SaleRet).unwrap();
        assert!(i.starts_with("INV/"));
        assert!(q.starts_with("QTN/"));
        assert!(r.starts_with("RET/"));
        assert!(i.ends_with("/001"));
        assert!(q.ends_with("/001"));
        assert!(r.ends_with("/001"));
    }

    #[test]
    fn gap_aware_daily_sequence_does_not_reuse() {
        // Per plan §12: gap-aware means we never go back to fill a gap. We
        // simulate: (a) two successful mints → 001, 002; (b) manually bump the
        // daily counter row to 5; (c) next mint must return 006 — proving we do
        // not re-use 003/004/005.
        let db = Db::open_in_memory().unwrap();
        let a = mint_next(&db, Kind::SaleInv).unwrap();
        let b = mint_next(&db, Kind::SaleInv).unwrap();
        assert!(a.ends_with("/001"));
        assert!(b.ends_with("/002"));
        // Manually jump the daily counter to 5 for today's row.
        let date = today_ddmmyyyy();
        db.with_conn(|c| -> anyhow::Result<()> {
            c.execute(
                "UPDATE daily_counters SET last_serial = 5 WHERE prefix = 'INV' AND date = ?1",
                rusqlite::params![&date],
            )?;
            Ok(())
        })
        .unwrap();
        let next = mint_next(&db, Kind::SaleInv).unwrap();
        // Next is 006 — gap 003..005 is preserved (not filled).
        assert!(next.ends_with("/006"), "expected 006, got {}", next);
    }
}

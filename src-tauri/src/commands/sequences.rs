//! Sequence numbering for sale invoices and quotations.
//!
//! Per master plan §12:
//!   UPDATE sequences SET last_value = last_value + 1
//!     WHERE name IN ('sale_inv' | 'sale_qtn' | 'sku')
//!     RETURNING last_value;
//!   Format: `INV-{YYYY}-{seq:04}` or `QTN-{YYYY}-{seq:04}` (or 5-digit for SKU).
//!   Gap-aware (gaps are acceptable in v1; sequence is never reused).

use chrono::Local;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::commands::auth::AppState;

/// Kinds of sequence we mint. `Sku` is exposed so other commands can use the
/// same primitive (Slice B's item-create will need it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    SaleInv,
    SaleQtn,
    Sku,
}

impl Kind {
    fn as_seq_name(self) -> &'static str {
        match self {
            Kind::SaleInv => "sale_inv",
            Kind::SaleQtn => "sale_qtn",
            Kind::Sku => "sku",
        }
    }

    fn width(self) -> usize {
        match self {
            Kind::Sku => 5,
            _ => 4,
        }
    }
}

/// Mint the next number for `kind` and return it as a fully-formatted string.
///
/// Atomically increments `sequences.last_value` and reads it back. Sequence
/// rows are seeded by the migration; this assumes they exist.
pub fn mint_next(db: &Db, kind: Kind) -> anyhow::Result<String> {
    db.with_conn_immediate(|c| {
        // Atomic bump + read. If the row doesn't exist yet we INSERT it.
        let next: i64 = c
            .query_row(
                "INSERT INTO sequences(name,last_value)
                 VALUES (?1, 1)
                 ON CONFLICT(name) DO UPDATE
                   SET last_value = last_value + 1
                 RETURNING last_value",
                rusqlite::params![kind.as_seq_name()],
                |r| r.get(0),
            )?;
        Ok(format_number(kind, next))
    })
}

/// Mint only when the kind is sale-style (Invoice or Quotation). SKU is
/// exposed for symmetry but `mint_next_sale_no` is the helper Slice C uses
/// internally for sales + day-close rows.
pub fn mint_next_sale_no(db: &Db, kind: Kind) -> anyhow::Result<String> {
    match kind {
        Kind::SaleInv | Kind::SaleQtn => mint_next(db, kind),
        Kind::Sku => anyhow::bail!("mint_next_sale_no called with Sku"),
    }
}

fn format_number(kind: Kind, n: i64) -> String {
    let yyyy = Local::now().format("%Y").to_string();
    let s = format!("{:0width$}", n, width = kind.width());
    match kind {
        Kind::SaleInv => format!("INV-{}-{}", yyyy, s),
        Kind::SaleQtn => format!("QTN-{}-{}", yyyy, s),
        Kind::Sku => format!("SKU-{}", s),
    }
}

/// Parse a sale number and return the (kind, year, seq) triple. Used by the
/// "convert_quotation" path to validate a `no` we just minted.
pub fn parse(no: &str) -> Option<(Kind, i32, i64)> {
    let parts: Vec<&str> = no.splitn(3, '-').collect();
    if parts.len() != 3 {
        return None;
    }
    let (kind, year, seq) = (parts[0], parts[1], parts[2]);
    let kind = match kind {
        "INV" => Kind::SaleInv,
        "QTN" => Kind::SaleQtn,
        _ => return None,
    };
    let year: i32 = year.parse().ok()?;
    let seq: i64 = seq.parse().ok()?;
    Some((kind, year, seq))
}

// -----------------------------------------------------------------------------
// Tauri command surface.
// -----------------------------------------------------------------------------

#[tauri::command]
pub fn cmd_mint_next_sale_no(
    state: tauri::State<'_, AppState>,
    kind: String,
) -> AppResult<String> {
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let k = match kind.as_str() {
        "inv" | "sale_inv" | "INV" => Kind::SaleInv,
        "qtn" | "sale_qtn" | "QTN" => Kind::SaleQtn,
        _ => return Err(AppError::Internal(format!("unknown sequence kind: {}", kind))),
    };
    mint_next_sale_no(db, k).map_err(|e| AppError::Internal(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_with_year_and_4_digits() {
        let s = format_number(Kind::SaleInv, 1);
        let cur_year = Local::now().format("%Y").to_string();
        assert!(s.starts_with(&format!("INV-{}-", cur_year)));
        assert!(s.ends_with("0001"));
    }

    #[test]
    fn sku_is_5_digits() {
        let s = format_number(Kind::Sku, 7);
        assert!(s.starts_with("SKU-"));
        assert!(s.ends_with("00007"));
    }

    #[test]
    fn parse_round_trip() {
        let s = "INV-2026-0042";
        let (k, y, n) = parse(s).unwrap();
        assert_eq!(k, Kind::SaleInv);
        assert_eq!(y, 2026);
        assert_eq!(n, 42);
        assert!(parse("garbage").is_none());
    }

    #[test]
    fn mint_next_atomic_and_increments() {
        let db = Db::open_in_memory().unwrap();
        // First INV
        let a = mint_next(&db, Kind::SaleInv).unwrap();
        let b = mint_next(&db, Kind::SaleInv).unwrap();
        let c = mint_next(&db, Kind::SaleInv).unwrap();
        assert!(a.ends_with("0001"));
        assert!(b.ends_with("0002"));
        assert!(c.ends_with("0003"));
    }

    #[test]
    fn mint_inv_and_qtn_independent() {
        let db = Db::open_in_memory().unwrap();
        let i1 = mint_next(&db, Kind::SaleInv).unwrap();
        let q1 = mint_next(&db, Kind::SaleQtn).unwrap();
        assert!(i1.starts_with("INV-"));
        assert!(q1.starts_with("QTN-"));
        assert!(i1.ends_with("0001"));
        assert!(q1.ends_with("0001"));
    }

    #[test]
    fn gap_aware_sequence_does_not_reuse() {
        // Per plan §12: gap-aware means we never go back to fill a gap. We
        // simulate: (a) two successful mints → 0001, 0002; (b) manually bump
        // the seq row to 5; (c) next mint must return 0006 — proving we do
        // not re-use 0003/0004/0005.
        let db = Db::open_in_memory().unwrap();
        let a = mint_next(&db, Kind::SaleInv).unwrap();
        let b = mint_next(&db, Kind::SaleInv).unwrap();
        assert!(a.ends_with("0001"));
        assert!(b.ends_with("0002"));
        // Manually jump the counter to 5.
        db.with_conn(|c| -> anyhow::Result<()> {
            c.execute(
                "UPDATE sequences SET last_value = 5 WHERE name = 'sale_inv'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        let next = mint_next(&db, Kind::SaleInv).unwrap();
        // Next is 0006 — gap 0003..0005 is preserved (not filled).
        assert!(next.ends_with("0006"), "expected 0006, got {}", next);
    }
}

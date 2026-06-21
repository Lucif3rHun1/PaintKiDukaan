//! Brand registry + EAN-13 barcode generator.
//!
//! Owns the `brands` and `brand_sequences` tables (introduced in schema v3)
//! and the EAN-13 code generator used by `create_item` when the
//! `auto_generate_barcode` setting is on.
//!
//! Code shape: GS1 prefix `890` (India) + 5-digit brand area + 4-digit seq
//! + EAN-13 check digit = 13 digits.
//! Example: brand_id=1, seq=1 → body `890000010001` → check `3` → `8900000100013`.

use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::auth::AppState;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Brand {
    pub id: i64,
    pub name: String,
    pub code_prefix: String,
    pub next_seq: i64,
}

fn row_to_brand(r: &rusqlite::Row) -> rusqlite::Result<Brand> {
    Ok(Brand {
        id: r.get(0)?,
        name: r.get(1)?,
        code_prefix: r.get(2)?,
        next_seq: r.get(3)?,
    })
}

fn fetch_brand(conn: &rusqlite::Connection, id: i64) -> AppResult<Brand> {
    conn.query_row(
        "SELECT b.id, b.name, b.code_prefix, COALESCE(s.next_seq, 1) \
         FROM brands b LEFT JOIN brand_sequences s ON s.brand_id = b.id \
         WHERE b.id = ?1",
        params![id],
        row_to_brand,
    )
    .map_err(AppError::from)
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn list_brands(state: State<'_, AppState>) -> AppResult<Vec<Brand>> {
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let _ = crate::session::current_user()?;
    db.with_raw(|c| {
        let mut stmt = c.prepare(
            "SELECT b.id, b.name, b.code_prefix, COALESCE(s.next_seq, 1) \
             FROM brands b LEFT JOIN brand_sequences s ON s.brand_id = b.id \
             ORDER BY b.name ASC",
        )?;
        let rows = stmt.query_map([], row_to_brand)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn get_brand(state: State<'_, AppState>, id: i64) -> AppResult<Brand> {
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let _ = crate::session::current_user()?;
    db.with_raw(|conn| fetch_brand(conn, id))
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn update_brand_code_prefix(
    state: State<'_, AppState>,
    id: i64,
    code_prefix: String,
) -> AppResult<Brand> {
    let prefix = code_prefix.trim().to_uppercase();
    if prefix.is_empty() || prefix.len() > 4 {
        return Err(AppError::Validation(
            "code_prefix must be 1-4 characters".into(),
        ));
    }
    if !prefix.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(AppError::Validation(
            "code_prefix must be alphanumeric".into(),
        ));
    }
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    db.with_tx(|tx| {
        let existing: i64 = tx.query_row(
            "SELECT COUNT(*) FROM brands WHERE code_prefix = ?1 AND id != ?2",
            params![prefix, id],
            |r| r.get(0),
        )?;
        if existing > 0 {
            return Err(AppError::Conflict(format!(
                "code_prefix '{prefix}' already in use"
            )));
        }
        tx.execute(
            "UPDATE brands SET code_prefix = ?1 WHERE id = ?2",
            params![prefix, id],
        )?;
        fetch_brand(tx, id)
    })
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn create_brand(
    state: State<'_, AppState>,
    name: String,
    code_prefix: String,
) -> AppResult<Brand> {
    let name = name.trim().to_string();
    let prefix = code_prefix.trim().to_uppercase();
    if name.is_empty() {
        return Err(AppError::Validation("brand name is required".into()));
    }
    if prefix.is_empty() || prefix.len() > 4 {
        return Err(AppError::Validation(
            "code_prefix must be 1-4 characters".into(),
        ));
    }
    if !prefix.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(AppError::Validation(
            "code_prefix must be alphanumeric".into(),
        ));
    }
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    db.with_tx(|tx| {
        let collision: i64 = tx.query_row(
            "SELECT COUNT(*) FROM brands WHERE code_prefix = ?1",
            params![prefix],
            |r| r.get(0),
        )?;
        if collision > 0 {
            return Err(AppError::Conflict(format!(
                "code_prefix '{prefix}' already in use"
            )));
        }
        tx.execute(
            "INSERT INTO brands (name, code_prefix) VALUES (?1, ?2)",
            params![name, prefix],
        )?;
        let id = tx.last_insert_rowid() as i64;
        tx.execute(
            "INSERT INTO brand_sequences (brand_id, next_seq) VALUES (?1, 1)",
            params![id],
        )?;
        fetch_brand(tx, id)
    })
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn deactivate_brand(
    state: State<'_, AppState>,
    id: i64,
) -> AppResult<()> {
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    db.with_tx(|tx| {
        let in_use: i64 = tx.query_row(
            "SELECT COUNT(*) FROM items WHERE brand_id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        if in_use > 0 {
            return Err(AppError::Conflict(format!(
                "brand is referenced by {in_use} item(s); archive the items first"
            )));
        }
        let changed = tx.execute(
            "DELETE FROM brand_sequences WHERE brand_id = ?1",
            params![id],
        )?;
        let _ = changed;
        tx.execute("DELETE FROM brands WHERE id = ?1", params![id])?;
        Ok(())
    })
}

/// Read-only preview of what the next barcode WOULD be without bumping the sequence.
/// Used by the item form to show the user the code before they save.
#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn preview_next_barcode(
    state: State<'_, AppState>,
    brand_id: i64,
    _item_name: String,
) -> AppResult<String> {
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    db.with_raw(|conn| {
        let brand = fetch_brand(conn, brand_id)?;
        Ok(format_ean13_body(brand_id, brand.next_seq))
    })
}

/// Mint and persist the next EAN-13 barcode for a brand.
/// Atomically bumps `brand_sequences.next_seq` and returns the assigned code.
/// Called from `create_item` inside its transaction so the sequence and the
/// item row land together (or roll back together).
pub fn generate_brand_barcode(
    conn: &rusqlite::Connection,
    brand_id: i64,
    _item_name: &str,
) -> AppResult<String> {
    let brand = fetch_brand(conn, brand_id)?;
    conn.execute(
        "UPDATE brand_sequences SET next_seq = next_seq + 1 WHERE brand_id = ?1",
        params![brand_id],
    )?;
    let next_seq: i64 = conn.query_row(
        "SELECT next_seq FROM brand_sequences WHERE brand_id = ?1",
        params![brand_id],
        |r| r.get(0),
    )?;
    let seq = next_seq - 1;
    if seq < 0 || seq > 9999 {
        return Err(AppError::Conflict(format!(
            "Sequence exhausted for brand {} (max 9999 codes per brand)",
            brand.name
        )));
    }
    Ok(format_ean13_body(brand_id, seq))
}

/// Build a 12-digit EAN-13 body for a (brand_id, sequence) pair and append
/// the check digit. Returns a 13-digit string.
fn format_ean13_body(brand_id: i64, seq: i64) -> String {
    let body = format!(
        "890{:05}{:04}",
        (brand_id as u64).min(99_999),
        (seq as u64).min(9999)
    );
    let check = ean13_check_digit(&body);
    format!("{}{}", body, check)
}

/// EAN-13 check digit: weight odd positions × 1, even positions × 3,
/// sum mod 10, then (10 - mod) mod 10.
fn ean13_check_digit(body12: &str) -> u8 {
    let digits: Vec<u8> = body12.bytes().filter_map(|b| (b as char).to_digit(10)).map(|d| d as u8).collect();
    let sum: u32 = digits
        .iter()
        .enumerate()
        .map(|(i, &d)| {
            let weight = if i % 2 == 0 { 1 } else { 3 };
            d as u32 * weight
        })
        .sum();
    ((10 - (sum % 10)) % 10) as u8
}

#[cfg(test)]
mod tests {
    use super::{ean13_check_digit, format_ean13_body};

    #[test]
    fn ean13_check_known_values() {
        // Standard test vectors from GS1 spec.
        assert_eq!(ean13_check_digit("590123412345"), 7);
        assert_eq!(ean13_check_digit("978020137962"), 4);
        assert_eq!(ean13_check_digit("400638133393"), 1);
    }

    #[test]
    fn format_body_appends_check() {
        let code = format_ean13_body(1, 1);
        assert_eq!(code.len(), 13);
        assert!(code.starts_with("890"));
        // Validate the check digit in the full string.
        let (body, check) = code.split_at(12);
        let expected = ean13_check_digit(body).to_string();
        assert_eq!(check, expected);
    }

    #[test]
    fn format_body_zero_seq() {
        let code = format_ean13_body(42, 0);
        assert_eq!(code, format!("89000042{:04}{}", 0, ean13_check_digit("890000420000")));
    }
}
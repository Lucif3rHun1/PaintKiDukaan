//! Brand registry + brand-prefixed barcode generator.
//!
//! Owns the `brands` and `brand_sequences` tables (introduced in schema v3)
//! and the `APACE001`-style code generator used by `create_item` when the
//! `auto_generate_barcode` setting is on.
//!
//! Code shape: `{code_prefix}{3-char-product-token}{seq:03}`
//! Example: Asian Paints (AP) + "Ace Exterior" → token "ACE", seq 1 → `APACE001`.

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

/// Read-only preview of what the next barcode WOULD be without bumping the sequence.
/// Used by the item form to show the user the code before they save.
#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn preview_next_barcode(
    state: State<'_, AppState>,
    brand_id: i64,
    item_name: String,
) -> AppResult<String> {
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    db.with_raw(|conn| {
        let brand = fetch_brand(conn, brand_id)?;
        let token = derive_product_token(&item_name, &brand.name);
        Ok(format!("{}{}{:03}", brand.code_prefix, token, brand.next_seq))
    })
}

/// Mint and persist the next brand-prefixed barcode.
/// Atomically bumps `brand_sequences.next_seq` and returns the assigned code.
/// Called from `create_item` inside its transaction so the sequence and the
/// item row land together (or roll back together).
pub fn generate_brand_barcode(
    conn: &rusqlite::Connection,
    brand_id: i64,
    item_name: &str,
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
    if seq < 0 || seq > 999 {
        return Err(AppError::Conflict(format!(
            "Sequence exhausted for brand {} (max 999 codes per brand)",
            brand.name
        )));
    }
    let token = derive_product_token(item_name, &brand.name);
    Ok(format!("{}{}{:03}", brand.code_prefix, token, seq))
}

/// Derive the 3-character product token from the item name and brand name.
///
/// Strategy: skip leading words of `item_name` that match leading words of
/// `brand_name` (case-insensitive, allowing a one-sided prefix match so
/// "Asian Paints" brand + "Asian Paint Ace Exterior" item still skips both).
/// Then take the first 3 chars of the next word, uppercased. Pad with 'X'
/// if the word is shorter than 3 chars; fall back to "XXX" if item_name is empty.
fn derive_product_token(item_name: &str, brand_name: &str) -> String {
    let name = item_name.trim();
    if name.is_empty() {
        return "XXX".to_string();
    }
    let brand_words: Vec<&str> = brand_name.split_whitespace().collect();
    let name_words: Vec<&str> = name.split_whitespace().collect();

    let mut skip = 0usize;
    for (i, bw) in brand_words.iter().enumerate() {
        match name_words.get(i) {
            Some(nw) if nw.eq_ignore_ascii_case(bw) => {
                skip = i + 1;
            }
            _ => break,
        }
    }
    // Partial-stem allow: if first word matched but second differs only by
    // suffix (e.g. "Paints" vs "Paint"), still skip it.
    if skip == 1 && brand_words.len() >= 2 && name_words.len() >= 2 {
        let n2 = name_words[1].to_lowercase();
        let b2 = brand_words[1].to_lowercase();
        if b2.starts_with(&n2) || n2.starts_with(&b2) {
            skip = 2;
        }
    }

    let remainder = name_words
        .iter()
        .skip(skip)
        .copied()
        .collect::<Vec<_>>()
        .join(" ");
    let token: String = remainder
        .chars()
        .filter(|c| c.is_alphanumeric())
        .take(3)
        .collect::<String>()
        .to_uppercase();
    if token.is_empty() {
        "XXX".to_string()
    } else if token.len() < 3 {
        format!("{}{}", token, "X".repeat(3 - token.len()))
    } else {
        token
    }
}

#[cfg(test)]
mod tests {
    use super::derive_product_token;

    #[test]
    fn strips_brand_name_then_takes_three_chars() {
        assert_eq!(
            derive_product_token("Asian Paint Ace Exterior", "Asian Paints"),
            "ACE"
        );
        assert_eq!(derive_product_token("Ace Exterior", "Asian Paints"), "ACE");
        assert_eq!(
            derive_product_token("Supreme White", "Birla Opus"),
            "SUP"
        );
        assert_eq!(
            derive_product_token("Birla Opus Supreme White", "Birla Opus"),
            "SUP"
        );
    }

    #[test]
    fn pads_short_words() {
        assert_eq!(derive_product_token("XL Enamel", "Asian Paints"), "XLE");
        assert_eq!(derive_product_token("Ace", "Asian Paints"), "ACE");
        assert_eq!(derive_product_token("Go", "Asian Paints"), "GOX");
    }

    #[test]
    fn fallback_when_empty() {
        assert_eq!(derive_product_token("", "Asian Paints"), "XXX");
        assert_eq!(derive_product_token("   ", "Asian Paints"), "XXX");
    }
}
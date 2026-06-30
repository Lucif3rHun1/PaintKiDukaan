//! Items CRUD + role-aware lookup.
//!
//! `lookup_item` is the hot path for the POS barcode scanner: the server
//! returns different fields depending on the caller role. This is enforced
//! server-side so a malicious frontend cannot see cost_paise as a cashier.

use crate::commands::auth::AppState;
use crate::error::{AppError, AppResult};
use crate::session::{current_user, require_role, Role};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Item {
    pub id: i64,
    pub sku_code: String,
    pub barcode: Option<String>,
    pub name: String,
    pub brand: Option<String>,
    pub category: Option<String>,
    pub unit_code: String,
    pub unit_label: String,
    pub unit: String,
    pub units_per_pack: Option<f64>,
    pub sell_unit: String,
    pub sell_unit_id: Option<i64>,
    pub retail_price_paise: i64,
    pub cost_paise: i64,
    pub promo_price_paise: Option<i64>,
    pub label_line1: Option<String>,
    pub label_line2: Option<String>,
    pub primary_location_id: Option<i64>,
    pub sub_location_id: Option<i64>,
    pub position: Option<String>,
    pub min_stock: f64,
    pub barcode_format: Option<String>,
    pub is_active: bool,
    pub current_qty: f64,
    pub created_at: String,
    pub updated_at: String,
    pub brand_id: Option<i64>,
}

/// Minimal projection for the role-aware `lookup_item`.
///
/// - `Owner`: all fields, including cost_paise.
/// - `Cashier`: name, retail_price_paise, sell_unit, in_stock (aggregate across locations).
/// - `Stocker`: name, qty_per_loc (grouped), min_stock.
#[derive(Debug, Serialize, Clone)]
#[serde(tag = "scope", rename_all = "lowercase")]
pub enum ItemLookup {
    Owner(Box<Item>),
    Cashier {
        id: i64,
        sku_code: String,
        name: String,
        retail_price_paise: i64,
        sell_unit: String,
        unit: String,
        units_per_pack: Option<f64>,
        in_stock: f64,
    },
    Stocker {
        id: i64,
        sku_code: String,
        name: String,
        min_stock: f64,
        qty_per_loc: Vec<QtyPerLoc>,
    },
}

#[derive(Debug, Serialize, Clone)]
pub struct QtyPerLoc {
    pub location: String,
    pub qty: f64,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct ItemFilter {
    pub query: Option<String>,
    pub brand: Option<String>,
    pub category: Option<String>,
    pub low_stock_only: bool,
    pub include_inactive: bool,
    pub archived_only: bool,
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct NewItem {
    pub name: String,
    pub brand: Option<String>,
    pub brand_id: Option<i64>,
    pub category: Option<String>,
    pub unit: Option<String>,
    pub unit_code: Option<String>,
    pub unit_label: Option<String>,
    pub units_per_pack: Option<f64>,
    pub sell_unit: Option<String>,
    pub sell_unit_id: Option<i64>,
    pub retail_price_paise: i64,
    pub cost_paise: i64,
    pub promo_price_paise: Option<i64>,
    pub label_line1: Option<String>,
    pub label_line2: Option<String>,
    pub primary_location_id: i64,
    pub sub_location_id: Option<i64>,
    pub position: Option<String>,
    pub min_stock: Option<f64>,
    pub barcode_format: Option<String>,
    pub barcode: Option<String>,
}


#[derive(Debug, Deserialize)]
pub struct ItemUpdate {
    pub name: Option<String>,
    pub brand: Option<String>,
    pub brand_id: Option<i64>,
    pub category: Option<String>,
    pub unit: Option<String>,
    pub unit_code: Option<String>,
    pub unit_label: Option<String>,
    pub units_per_pack: Option<f64>,
    pub sell_unit: Option<String>,
    pub sell_unit_id: Option<i64>,
    pub retail_price_paise: Option<i64>,
    pub cost_paise: Option<i64>,
    pub promo_price_paise: Option<i64>,
    pub label_line1: Option<String>,
    pub label_line2: Option<String>,
    pub primary_location_id: Option<i64>,
    pub sub_location_id: Option<i64>,
    pub position: Option<String>,
    pub min_stock: Option<f64>,
    pub barcode_format: Option<String>,
    pub barcode: Option<String>,
    pub is_active: Option<bool>,
}

/// Helper: convert a line quantity to base units.
/// With the 3-unit system, sell_unit is always the base unit (unit/mtr/kg),
/// so this is a passthrough. Purchase packaging is handled separately.
pub fn to_base_units(qty: f64, _sell_unit: &str, _units_per_pack: Option<f64>) -> f64 {
    qty
}

/// Mint the next SKU and return it. Called inside the create_item transaction
/// so the sequence advances atomically.
///
/// SKU format is name-based for readability:
///   With brand:  `{BRAND_PREFIX}-{NAME_ABBR}-{SEQ:03}`  e.g. `AP-WHT-001`
///   Without brand: `{NAME_ABBR}-{SEQ:03}`               e.g. `WHT-001`
fn mint_next_sku(
    tx: &rusqlite::Connection,
    item_name: &str,
    brand_prefix: Option<&str>,
) -> AppResult<String> {
    tx.execute(
        "UPDATE sequences SET value = value + 1 WHERE name = 'sku'",
        [],
    )?;
    let n: i64 = tx.query_row("SELECT value FROM sequences WHERE name = 'sku'", [], |r| {
        r.get(0)
    })?;
    let name_abbr = make_name_abbreviation(item_name);
    match brand_prefix {
        Some(prefix) => Ok(format!("{}-{}-{:03}", prefix.to_uppercase(), name_abbr, n)),
        None => Ok(format!("{}-{:03}", name_abbr, n)),
    }
}

/// Extract a short uppercase abbreviation from an item name for SKU generation.
/// Takes the first meaningful word(s), up to 4 chars total.
/// Examples: "Asian Paints Apex" → "APA", "White Cement" → "WHI", "Roller 4 inch" → "ROL"
pub fn make_name_abbreviation(name: &str) -> String {
    let words: Vec<&str> = name.split_whitespace().collect();
    let mut abbr = String::new();
    for word in &words {
        let clean: String = word.chars().filter(|c| c.is_alphabetic()).collect();
        if clean.is_empty() {
            continue;
        }
        if abbr.is_empty() {
            // First word: take up to 3 chars
            let take = clean.len().min(3);
            abbr.push_str(&clean[..take].to_uppercase());
        } else {
            // Subsequent words: take first char only
            let first = clean.chars().next().unwrap().to_uppercase().to_string();
            abbr.push_str(&first);
            if abbr.len() >= 4 {
                break;
            }
        }
    }
    // Pad with first char if too short
    if abbr.len() < 2 {
        if let Some(first_word) = words.first() {
            let clean: String = first_word.chars().filter(|c| c.is_alphabetic()).collect();
            while abbr.len() < 2 && !clean.is_empty() {
                abbr.push_str(&clean[..1].to_uppercase());
            }
        }
    }
    abbr
}

/// Title-case an item name and normalize unit abbreviations.
///
/// Handles number+unit adjacency ("1ltr" → "1 Ltr", "500ml" → "500 ml")
/// and normalizes unit casing ("Ml" → "ml", "LTR" → "Ltr").
/// Applied on create, update, and CSV import.
pub fn to_title_case(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return trimmed.to_string();
    }
    // Sorted longest-first so "inch" matches before "in", "sqft" before "ft", etc.
    const UNITS: &[&str] = &["sqft", "sqm", "inch", "ltr", "pcs", "nos", "ml", "kg", "gm", "mm", "cm", "ft", "pc", "no", "in", "l", "g", "m"];
    const UNIT_CASING: &[(&str, &str)] = &[
        ("sqft", "Sqft"), ("sqm", "Sqm"), ("inch", "Inch"),
        ("ltr", "Ltr"), ("pcs", "Pcs"), ("nos", "Nos"),
        ("ml", "ml"), ("kg", "Kg"), ("gm", "Gm"),
        ("mm", "mm"), ("cm", "cm"), ("ft", "Ft"),
        ("pc", "Pc"), ("no", "No"), ("in", "In"),
        ("l", "L"), ("g", "G"), ("m", "m"),
    ];

    fn title_word(s: &str) -> String {
        let lower = s.to_lowercase();
        let mut chars = lower.chars();
        match chars.next() {
            None => String::new(),
            Some(first) => {
                let upper: String = first.to_uppercase().collect();
                let rest: String = chars.collect();
                format!("{upper}{rest}")
            }
        }
    }

    fn normalize_unit(s: &str) -> String {
        let lower = s.to_lowercase();
        for &(lu, canonical) in UNIT_CASING {
            if lower == lu {
                return canonical.to_string();
            }
        }
        lower
    }

    fn is_known_unit(s: &str) -> bool {
        let lower = s.to_lowercase();
        UNITS.iter().any(|&u| lower == u)
    }

    let mut words = Vec::new();

    for token in trimmed.split_whitespace() {
        if is_known_unit(token) {
            words.push(normalize_unit(token));
            continue;
        }
        let split_at = token
            .char_indices()
            .find(|&(_, c)| !c.is_ascii_digit() && c != '.' && c != ',')
            .map(|(i, _)| i)
            .unwrap_or(token.len());
        if split_at > 0 && split_at < token.len() {
            let (number, rest) = token.split_at(split_at);
            if is_known_unit(rest) {
                words.push(number.to_string());
                words.push(normalize_unit(rest));
                continue;
            }
        }
        words.push(title_word(token));
    }

    words.join(" ")
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn create_item(state: State<'_, AppState>, payload: NewItem) -> AppResult<Item> {
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let user = current_user()?;
    require_role(&user, &[Role::Owner, Role::Stocker])?;
    if payload.name.trim().is_empty() {
        return Err(AppError::Validation("name is required".into()));
    }
    let normalized_name = to_title_case(&payload.name);
    if payload.retail_price_paise < 0 || payload.cost_paise < 0 {
        return Err(AppError::Validation("prices must be >= 0".into()));
    }
    if payload.primary_location_id <= 0 {
        return Err(AppError::Validation("primary location is required".into()));
    }

    // Read auto_generate_barcode setting before opening the txn so we
    // don't hold both settings.lock and db.lock concurrently.
    let auto_generate = {
        let settings = state
            .settings
            .lock()
            .map_err(|_| AppError::Internal("settings lock poisoned".into()))?;
        settings
            .get("auto_generate_barcode")
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    };

    // Resolve brand prefix for SKU generation (read before txn to avoid nested locks)
    let brand_prefix: Option<String> = payload.brand_id.and_then(|bid| {
        db.with_raw(|conn| {
            conn.query_row(
                "SELECT prefix FROM brands WHERE id = ?1",
                params![bid],
                |r| r.get::<_, String>(0),
            )
            .ok()
        })
    });

    db.with_tx(|tx| {
        let sku = mint_next_sku(tx, &normalized_name, brand_prefix.as_deref())?;
        // Barcode resolution order:
        // 1. caller-provided value
        // 2. auto-generated: SKU as barcode (CODE128 supports alphanumeric)
        // 3. fallback to SKU
        let barcode = if let Some(b) = payload.barcode.clone() {
            b
        } else if auto_generate {
            if let Some(_brand_id) = payload.brand_id {
                // Still bump brand_sequences so the counter stays in sync
                // even though we don't use the return value anymore.
                #[allow(deprecated)]
                let _ = crate::commands::brands::generate_brand_barcode(tx, _brand_id, &normalized_name);
                sku.clone()
            } else {
                sku.clone()
            }
        } else {
            sku.clone()
        };
        let barcode_format = payload.barcode_format.clone().unwrap_or_else(|| "CODE128".into());
        // Resolve brand text from brand_id if brand is null (frontend only sends brand_id)
        let brand_text = if payload.brand.is_some() {
            payload.brand.clone()
        } else if let Some(bid) = payload.brand_id {
            tx.query_row(
                "SELECT name FROM brands WHERE id = ?1",
                params![bid],
                |r| r.get::<_, Option<String>>(0),
            )
            .unwrap_or(None)
        } else {
            None
        };
        // Derive display unit fields from sale_unit_id
        let (unit_code_val, unit_label_val) = if let Some(suid) = payload.sell_unit_id {
            tx.query_row(
                "SELECT code, label FROM sale_units WHERE id = ?1",
                params![suid],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            ).unwrap_or_else(|_| ("pcs".into(), "Pcs".into()))
        } else {
            (payload.unit_code.clone().unwrap_or_else(|| "pcs".into()),
             payload.unit_label.clone().unwrap_or_else(|| "Unit".into()))
        };
        tx.execute(
            "INSERT INTO items (
                sku_code, barcode, name, brand, brand_id, category,
                unit_code, unit_label, unit, units_per_pack,
                sell_unit, sell_unit_id, retail_price_paise, cost_paise, promo_price_paise,
                label_line1, label_line2, primary_location_id,
                sub_location_id, position, min_stock, barcode_format, is_active,
                created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, 1, unixepoch('now'), unixepoch('now'))",
            params![
                sku,
                barcode,
                normalized_name,
                brand_text,
                payload.brand_id,
                payload.category,
                unit_code_val,
                unit_label_val,
                payload.unit.unwrap_or_else(|| "pcs".into()),
                payload.units_per_pack.unwrap_or(1.0),
                payload.sell_unit.clone().unwrap_or_else(|| "pcs".into()),
                payload.sell_unit_id,
                payload.retail_price_paise,
                payload.cost_paise,
                payload.promo_price_paise,
                payload.label_line1,
                payload.label_line2,
                payload.primary_location_id,
                payload.sub_location_id,
                payload.position,
                payload.min_stock.unwrap_or(0.0),
                barcode_format,
            ],
        )?;
        let id = tx.last_insert_rowid();
        fetch_item_tx(tx, id)
    })
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn update_item(state: State<'_, AppState>, id: i64, patch: ItemUpdate) -> AppResult<Item> {
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let user = current_user()?;
    require_role(&user, &[Role::Owner, Role::Stocker])?;
    db.with_tx(|tx| {
        // Build a dynamic SET clause from the non-None fields.
        let mut sets: Vec<&'static str> = Vec::new();
        let mut values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        macro_rules! add {
            ($col:literal, $val:expr) => {{
                sets.push(concat!($col, " ?"));
                values.push(Box::new($val));
            }};
        }
        if let Some(v) = &patch.name {
            add!("name =", to_title_case(v))
        }
        if let Some(v) = &patch.brand {
            add!("brand =", v.clone())
        }
        if let Some(v) = patch.brand_id {
            add!("brand_id =", v)
        }
        if let Some(v) = &patch.category {
            add!("category =", v.clone())
        }
        if let Some(v) = &patch.unit {
            add!("unit =", v.clone())
        }
        if let Some(v) = patch.units_per_pack {
            add!("units_per_pack =", v)
        }
        if let Some(v) = &patch.sell_unit {
            add!("sell_unit =", v.clone())
        }
        if let Some(v) = patch.sell_unit_id {
            add!("sell_unit_id =", v)
        }
        if let Some(v) = patch.retail_price_paise {
            add!("retail_price_paise =", v)
        }
        if let Some(v) = patch.cost_paise {
            add!("cost_paise =", v)
        }
        if let Some(v) = patch.promo_price_paise {
            add!("promo_price_paise =", v)
        }
        if let Some(v) = &patch.label_line1 {
            add!("label_line1 =", v.clone())
        }
        if let Some(v) = &patch.label_line2 {
            add!("label_line2 =", v.clone())
        }
        if let Some(v) = patch.primary_location_id {
            add!("primary_location_id =", v)
        }
        if let Some(v) = patch.sub_location_id {
            add!("sub_location_id =", v)
        }
        if let Some(v) = &patch.position {
            add!("position =", v.clone())
        }
        if let Some(v) = patch.min_stock {
            add!("min_stock =", v)
        }
        if let Some(v) = &patch.barcode_format {
            add!("barcode_format =", v.clone())
        }
        if let Some(v) = &patch.barcode {
            add!("barcode =", v.clone())
        }
        if let Some(v) = patch.is_active {
            add!("is_active =", if v { 1_i64 } else { 0_i64 })
        }
        if sets.is_empty() {
            return Err(AppError::Validation("no fields to update".into()));
        }
        sets.push("updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000");
        let sql = format!("UPDATE items SET {} WHERE id = ?", sets.join(", "));
        let mut params_vec: Vec<&dyn rusqlite::ToSql> = values
            .iter()
            .map(|b| &**b as &dyn rusqlite::ToSql)
            .collect();
        params_vec.push(&id);
        let n = tx.execute(&sql, params_vec.as_slice())?;
        if n == 0 {
            return Err(AppError::NotFound(format!("item {id}")));
        }
        fetch_item_tx(tx, id)
    })
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn list_items(state: State<'_, AppState>, filter: ItemFilter) -> AppResult<Vec<Item>> {
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let _ = current_user()?;
    let mut sql = String::from("SELECT i.id, i.sku_code, i.barcode, i.name, COALESCE(b.name, i.brand) AS brand, i.category, i.unit_code, i.unit_label, i.unit, i.units_per_pack, i.sell_unit, i.sell_unit_id, i.retail_price_paise, i.cost_paise, i.promo_price_paise, i.label_line1, i.label_line2, i.primary_location_id, i.sub_location_id, i.position, i.min_stock, i.barcode_format, i.is_active, i.created_at, i.updated_at, COALESCE(sb.qty, 0) AS current_qty, i.brand_id FROM items i LEFT JOIN brands b ON b.id = i.brand_id LEFT JOIN (SELECT item_id, SUM(qty) AS qty FROM stock_balances GROUP BY item_id) sb ON sb.item_id = i.id WHERE 1=1");
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if filter.archived_only {
        sql.push_str(" AND i.is_active = 0");
    } else if !filter.include_inactive {
        sql.push_str(" AND i.is_active = 1");
    }
    if let Some(q) = &filter.query {
        sql.push_str(" AND (i.name LIKE ?1 OR i.sku_code LIKE ?1 OR i.barcode LIKE ?1)");
        args.push(Box::new(format!("%{}%", q)));
    }
    if let Some(b) = &filter.brand {
        sql.push_str(&format!(" AND COALESCE(b.name, i.brand) = ?{}", args.len() + 1));
        args.push(Box::new(b.clone()));
    }
    if let Some(c) = &filter.category {
        sql.push_str(&format!(" AND i.category = ?{}", args.len() + 1));
        args.push(Box::new(c.clone()));
    }
    if filter.low_stock_only {
        sql.push_str(
            " AND i.id IN (SELECT item_id FROM stock_balances GROUP BY item_id \
             HAVING SUM(qty) <= (SELECT min_stock FROM items i2 WHERE i2.id = item_id))",
        );
    }
    sql.push_str(" ORDER BY i.name COLLATE NOCASE");
    let limit = filter.limit.unwrap_or(500);
    sql.push_str(&format!(" LIMIT {}", limit));
    db.with_raw(|c| {
        let mut stmt = c.prepare(&sql)?;
        let dyn_args: Vec<&dyn rusqlite::ToSql> =
            args.iter().map(|b| &**b as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(dyn_args.as_slice(), row_to_item)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    })
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn get_item(state: State<'_, AppState>, id: i64) -> AppResult<Item> {
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let _ = current_user()?;
    db.with_raw(|c| {
        let mut stmt = c.prepare(
            "SELECT i.id, i.sku_code, i.barcode, i.name, COALESCE(b.name, i.brand) AS brand, i.category, i.unit_code, i.unit_label, i.unit, i.units_per_pack, i.sell_unit, i.sell_unit_id, i.retail_price_paise, i.cost_paise, i.promo_price_paise, i.label_line1, i.label_line2, i.primary_location_id, i.sub_location_id, i.position, i.min_stock, i.barcode_format, i.is_active, i.created_at, i.updated_at, COALESCE(sb.qty, 0) AS current_qty, i.brand_id FROM items i LEFT JOIN brands b ON b.id = i.brand_id LEFT JOIN (SELECT item_id, SUM(qty) AS qty FROM stock_balances GROUP BY item_id) sb ON sb.item_id = i.id WHERE i.id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], row_to_item)?;
        rows.next()
            .ok_or_else(|| AppError::NotFound(format!("item {id}")))?
            .map_err(Into::into)
    })
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn lookup_item(state: State<'_, AppState>, code: String) -> AppResult<Option<ItemLookup>> {
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let user = current_user()?;
    // Search by barcode OR sku_code OR name match (best-effort).
    db.with_raw(|c| {
        let mut stmt = c.prepare(
            "SELECT i.id, i.sku_code, i.barcode, i.name, COALESCE(b.name, i.brand) AS brand, i.category, i.unit_code, i.unit_label, i.unit, i.units_per_pack, i.sell_unit, i.sell_unit_id, i.retail_price_paise, i.cost_paise, i.promo_price_paise, i.label_line1, i.label_line2, i.primary_location_id, i.sub_location_id, i.position, i.min_stock, i.barcode_format, i.is_active, i.created_at, i.updated_at, COALESCE(sb.qty, 0) AS current_qty, i.brand_id FROM items i LEFT JOIN brands b ON b.id = i.brand_id LEFT JOIN (SELECT item_id, SUM(qty) AS qty FROM stock_balances GROUP BY item_id) sb ON sb.item_id = i.id WHERE (i.barcode = ?1 OR i.sku_code = ?1) AND i.is_active = 1 LIMIT 1",
        )?;
        let mut rows = stmt.query_map(params![code], row_to_item)?;
        let item = match rows.next() {
            Some(Ok(i)) => i,
            Some(Err(e)) => return Err(e.into()),
            None => return Ok(None),
        };
        // Build role-specific projection.
        let result = match user.role {
            Role::Owner => ItemLookup::Owner(Box::new(item)),
            Role::Cashier => {
                let in_stock: f64 = c.query_row(
                    "SELECT COALESCE(SUM(qty), 0) FROM stock_balances WHERE item_id = ?1",
                    params![item.id],
                    |r| r.get(0),
                )?;
                ItemLookup::Cashier {
                    id: item.id,
                    sku_code: item.sku_code.clone(),
                    name: item.name.clone(),
                    retail_price_paise: item.retail_price_paise,
                    sell_unit: item.sell_unit.clone(),
                    unit: item.unit.clone(),
                    units_per_pack: item.units_per_pack,
                    in_stock,
                }
            }
            Role::Stocker => {
                let mut qstmt = c.prepare(
                    "SELECT l.name, sb.qty FROM stock_balances sb JOIN locations l ON l.id = sb.location_id WHERE sb.item_id = ?1 ORDER BY l.name",
                )?;
                let qty_per_loc: Vec<QtyPerLoc> = qstmt
                    .query_map(params![item.id], |r| {
                        Ok(QtyPerLoc { location: r.get(0)?, qty: r.get(1)? })
                    })?
                    .collect::<Result<_, _>>()?;
                ItemLookup::Stocker {
                    id: item.id,
                    sku_code: item.sku_code.clone(),
                    name: item.name.clone(),
                    min_stock: item.min_stock,
                    qty_per_loc,
                }
            }
        };
        Ok(Some(result))
    })
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn box_unit_conversion(
    state: State<'_, AppState>,
    item_id: i64,
    qty: f64,
) -> AppResult<ConversionResult> {
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let _ = current_user()?;
    db.with_raw(|c| {
        let (sell_unit, units_per_pack): (String, Option<f64>) = c.query_row(
            "SELECT sell_unit, units_per_pack FROM items WHERE id = ?1",
            params![item_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let base = to_base_units(qty, &sell_unit, units_per_pack);
        Ok(ConversionResult {
            qty,
            sell_unit,
            units_per_pack,
            qty_in_base_units: base,
        })
    })
}

#[derive(Debug, Serialize)]
pub struct ConversionResult {
    pub qty: f64,
    pub sell_unit: String,
    pub units_per_pack: Option<f64>,
    pub qty_in_base_units: f64,
}

// ---- Bulk normalisation ----

#[derive(Debug, Serialize)]
pub struct NormalizeResult {
    pub updated: i64,
}

/// Normalise every item name to title-case. Returns the count of rows changed.
#[tauri::command(rename_all = "snake_case")]
pub fn normalize_item_names(state: State<'_, AppState>) -> AppResult<NormalizeResult> {
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let _user = current_user()?;
    require_role(&_user, &[Role::Owner])?;

    db.with_raw(|c| {
        let mut stmt = c.prepare(
            "SELECT id, name FROM items WHERE is_active = 1",
        )?;
        let rows: Vec<(i64, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;

        let mut updated: i64 = 0;
        for (id, name) in &rows {
            let normalised = to_title_case(name);
            if normalised != *name {
                c.execute(
                    "UPDATE items SET name = ?1, updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE id = ?2",
                    params![normalised, id],
                )?;
                updated += 1;
            }
        }
        Ok(NormalizeResult { updated })
    })
}

// ---- internals ----

fn row_to_item(r: &rusqlite::Row<'_>) -> rusqlite::Result<Item> {
    Ok(Item {
        id: r.get(0)?,
        sku_code: r.get(1)?,
        barcode: r.get(2)?,
        name: r.get(3)?,
        brand: r.get(4)?,
        category: r.get(5)?,
        unit_code: r.get(6)?,
        unit_label: r.get(7)?,
        unit: r.get(8)?,
        units_per_pack: r.get(9)?,
        sell_unit: r.get(10)?,
        sell_unit_id: r.get(11)?,
        retail_price_paise: r.get(12)?,
        cost_paise: r.get(13)?,
        promo_price_paise: r.get(14)?,
        label_line1: r.get(15)?,
        label_line2: r.get(16)?,
        primary_location_id: r.get(17)?,
        sub_location_id: r.get(18)?,
        position: r.get(19)?,
        min_stock: r.get(20)?,
        barcode_format: r.get(21)?,
        is_active: r.get::<_, i64>(22)? != 0,
        created_at: r.get::<_, i64>(23)?.to_string(),
        updated_at: r.get::<_, i64>(24)?.to_string(),
        current_qty: r.get(25)?,
        brand_id: r.get(26)?,
    })
}

fn fetch_item_tx(tx: &rusqlite::Connection, id: i64) -> AppResult<Item> {
    let mut stmt = tx.prepare(
        "SELECT i.id, i.sku_code, i.barcode, i.name, COALESCE(b.name, i.brand) AS brand, i.category, i.unit_code, i.unit_label, i.unit, i.units_per_pack, i.sell_unit, i.sell_unit_id, i.retail_price_paise, i.cost_paise, i.promo_price_paise, i.label_line1, i.label_line2, i.primary_location_id, i.sub_location_id, i.position, i.min_stock, i.barcode_format, i.is_active, i.created_at, i.updated_at, COALESCE(sb.qty, 0) AS current_qty, i.brand_id FROM items i LEFT JOIN brands b ON b.id = i.brand_id LEFT JOIN (SELECT item_id, SUM(qty) AS qty FROM stock_balances GROUP BY item_id) sb ON sb.item_id = i.id WHERE i.id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], row_to_item)?;
    rows.next()
        .ok_or_else(|| AppError::NotFound(format!("item {id}")))?
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_base_units_handles_box() {
        assert_eq!(to_base_units(3.0, "box", Some(6.0)), 3.0);
        assert_eq!(to_base_units(3.0, "pcs", Some(6.0)), 3.0);
        assert_eq!(to_base_units(2.0, "box", None), 2.0);
    }
}

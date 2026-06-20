//! Items CRUD + role-aware lookup.
//!
//! `lookup_item` is the hot path for the POS barcode scanner: the server
//! returns different fields depending on the caller role. This is enforced
//! server-side so a malicious frontend cannot see cost_paise as a cashier.

use crate::error::{AppError, AppResult};
use crate::session::{current_user, require_role, Role};
use crate::db::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;
use crate::commands::auth::AppState;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Item {
    pub id: i64,
    pub sku_code: String,
    pub barcode: Option<String>,
    pub name: String,
    pub brand: Option<String>,
    pub category: Option<String>,
    pub unit: String,
    pub units_per_pack: Option<i64>,
    pub sell_unit: String,
    pub retail_price_paise: i64,
    pub cost_paise: i64,
    pub promo_price_paise: Option<i64>,
    pub label_line1: Option<String>,
    pub label_line2: Option<String>,
    pub location_text: Option<String>,
    pub primary_location_id: i64,
    pub min_qty: i64,
    pub barcode_format: String,
    pub is_active: bool,
    pub current_qty: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// Minimal projection for the role-aware `lookup_item`.
///
/// - `Owner`: all fields, including cost_paise.
/// - `Cashier`: name, retail_price_paise, sell_unit, in_stock (aggregate across locations), location_text.
/// - `Stocker`: name, location_text, qty_per_loc (grouped), min_qty.
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
        units_per_pack: Option<i64>,
        in_stock: f64,
        location_text: Option<String>,
    },
    Stocker {
        id: i64,
        sku_code: String,
        name: String,
        min_qty: i64,
        location_text: Option<String>,
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
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct NewItem {
    pub name: String,
    pub brand: Option<String>,
    pub brand_id: Option<i64>,
    pub category: Option<String>,
    pub unit: Option<String>,
    pub units_per_pack: Option<i64>,
    pub sell_unit: Option<String>,
    pub retail_price_paise: i64,
    pub cost_paise: i64,
    pub promo_price_paise: Option<i64>,
    pub label_line1: Option<String>,
    pub label_line2: Option<String>,
    pub location_text: Option<String>,
    pub primary_location_id: i64,
    pub min_qty: i64,
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
    pub units_per_pack: Option<i64>,
    pub sell_unit: Option<String>,
    pub retail_price_paise: Option<i64>,
    pub cost_paise: Option<i64>,
    pub promo_price_paise: Option<i64>,
    pub label_line1: Option<String>,
    pub label_line2: Option<String>,
    pub location_text: Option<String>,
    pub primary_location_id: Option<i64>,
    pub min_qty: Option<i64>,
    pub barcode_format: Option<String>,
    pub barcode: Option<String>,
    pub is_active: Option<bool>,
}

/// Helper: convert a line quantity in sell units to base units.
/// `units_per_pack` is the conversion factor when `sell_unit == "box"`.
pub fn to_base_units(qty: f64, sell_unit: &str, units_per_pack: Option<i64>) -> f64 {
    if sell_unit.eq_ignore_ascii_case("box") {
        qty * units_per_pack.unwrap_or(1) as f64
    } else {
        qty
    }
}

/// Mint the next SKU and return it. Called inside the create_item transaction
/// so the sequence advances atomically.
fn mint_next_sku(tx: &rusqlite::Connection) -> AppResult<String> {
    tx.execute(
        "UPDATE sequences SET last_value = last_value + 1 WHERE name = 'sku'",
        [],
    )?;
    let n: i64 = tx.query_row(
        "SELECT last_value FROM sequences WHERE name = 'sku'",
        [],
        |r| r.get(0),
    )?;
    Ok(format!("SKU-{n:06}"))
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn create_item(state: State<'_, AppState>, payload: NewItem) -> AppResult<Item> {
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let user = current_user()?;
    require_role(&user, &[Role::Owner, Role::Stocker])?;
    if payload.name.trim().is_empty() {
        return Err(AppError::Validation("name is required".into()));
    }
    if payload.retail_price_paise < 0 || payload.cost_paise < 0 {
        return Err(AppError::Validation("prices must be >= 0".into()));
    }
    if payload.primary_location_id <= 0 {
        return Err(AppError::Validation("primary location is required".into()));
    }

    // Read auto_generate_barcode setting before opening the txn so we
    // don't hold both settings.lock and db.lock concurrently.
    let auto_generate = {
        let settings = state.settings.lock().map_err(|_| AppError::Internal("settings lock poisoned".into()))?;
        settings
            .get("auto_generate_barcode")
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    };

    db.with_tx(|tx| {
        let sku = mint_next_sku(tx)?;
        // Barcode resolution order:
        // 1. caller-provided value
        // 2. auto-generated via brands::generate_brand_barcode (when ON + brand_id set)
        // 3. fallback to SKU
        let barcode = if let Some(b) = payload.barcode.clone() {
            b
        } else if auto_generate {
            if let Some(brand_id) = payload.brand_id {
                crate::commands::brands::generate_brand_barcode(tx, brand_id, &payload.name)?
            } else {
                sku.clone()
            }
        } else {
            sku.clone()
        };
        let barcode_format = payload.barcode_format.clone().unwrap_or_else(|| "CODE128".into());
        tx.execute(
            "INSERT INTO items (
                sku_code, barcode, name, brand, brand_id, category, unit, units_per_pack,
                sell_unit, retail_price_paise, cost_paise, promo_price_paise,
                label_line1, label_line2, location_text, primary_location_id,
                min_qty, barcode_format, is_active
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, 1)",
            params![
                sku,
                barcode,
                payload.name,
                payload.brand,
                payload.brand_id,
                payload.category,
                payload.unit.unwrap_or_else(|| "pc".into()),
                payload.units_per_pack,
                payload.sell_unit.unwrap_or_else(|| "unit".into()),
                payload.retail_price_paise,
                payload.cost_paise,
                payload.promo_price_paise,
                payload.label_line1,
                payload.label_line2,
                payload.location_text,
                payload.primary_location_id,
                payload.min_qty,
                barcode_format,
            ],
        )?;
        let id = tx.last_insert_rowid();
        fetch_item_tx(tx, id)
    })
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn update_item(state: State<'_, AppState>, id: i64, patch: ItemUpdate) -> AppResult<Item> {
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
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
        if let Some(v) = &patch.name { add!("name =", v.clone()) }
        if let Some(v) = &patch.brand { add!("brand =", v.clone()) }
        if let Some(v) = patch.brand_id { add!("brand_id =", v) }
        if let Some(v) = &patch.category { add!("category =", v.clone()) }
        if let Some(v) = &patch.unit { add!("unit =", v.clone()) }
        if let Some(v) = patch.units_per_pack { add!("units_per_pack =", v) }
        if let Some(v) = &patch.sell_unit { add!("sell_unit =", v.clone()) }
        if let Some(v) = patch.retail_price_paise { add!("retail_price_paise =", v) }
        if let Some(v) = patch.cost_paise { add!("cost_paise =", v) }
        if let Some(v) = patch.promo_price_paise { add!("promo_price_paise =", v) }
        if let Some(v) = &patch.label_line1 { add!("label_line1 =", v.clone()) }
        if let Some(v) = &patch.label_line2 { add!("label_line2 =", v.clone()) }
        if let Some(v) = &patch.location_text { add!("location_text =", v.clone()) }
        if let Some(v) = patch.primary_location_id { add!("primary_location_id =", v) }
        if let Some(v) = patch.min_qty { add!("min_qty =", v) }
        if let Some(v) = &patch.barcode_format { add!("barcode_format =", v.clone()) }
        if let Some(v) = &patch.barcode { add!("barcode =", v.clone()) }
        if let Some(v) = patch.is_active { add!("is_active =", if v { 1_i64 } else { 0_i64 }) }
        if sets.is_empty() {
            return Err(AppError::Validation("no fields to update".into()));
        }
        sets.push("updated_at = datetime('now')");
        let sql = format!("UPDATE items SET {} WHERE id = ?", sets.join(", "));
        let mut params_vec: Vec<&dyn rusqlite::ToSql> = values.iter().map(|b| &**b as &dyn rusqlite::ToSql).collect();
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
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let _ = current_user()?;
    let mut sql = String::from("SELECT i.id, i.sku_code, i.barcode, i.name, i.brand, i.category, i.unit, i.units_per_pack, i.sell_unit, i.retail_price_paise, i.cost_paise, i.promo_price_paise, i.label_line1, i.label_line2, i.location_text, i.primary_location_id, i.min_qty, i.barcode_format, i.is_active, i.created_at, i.updated_at, COALESCE((SELECT SUM(qty) FROM stock_balances WHERE item_id = i.id), 0) AS current_qty FROM items i WHERE 1=1");
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if !filter.include_inactive { sql.push_str(" AND i.is_active = 1"); }
    if let Some(q) = &filter.query {
        sql.push_str(" AND (i.name LIKE ?1 OR i.sku_code LIKE ?1 OR i.barcode LIKE ?1)");
        args.push(Box::new(format!("%{}%", q)));
    }
    if let Some(b) = &filter.brand {
        sql.push_str(&format!(" AND i.brand = ?{}", args.len() + 1));
        args.push(Box::new(b.clone()));
    }
    if let Some(c) = &filter.category {
        sql.push_str(&format!(" AND i.category = ?{}", args.len() + 1));
        args.push(Box::new(c.clone()));
    }
    if filter.low_stock_only {
        // qty vs min_qty, computed via stock_balances aggregate
        sql.push_str(
            " AND i.id IN (SELECT item_id FROM stock_balances GROUP BY item_id \
             HAVING SUM(qty) <= (SELECT min_qty FROM items i2 WHERE i2.id = item_id))",
        );
    }
    sql.push_str(" ORDER BY i.name");
    let limit = filter.limit.unwrap_or(500);
    sql.push_str(&format!(" LIMIT {}", limit));
    db.with_raw(|c| {
        let mut stmt = c.prepare(&sql)?;
        let dyn_args: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| &**b as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(dyn_args.as_slice(), row_to_item)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    })
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn get_item(state: State<'_, AppState>, id: i64) -> AppResult<Item> {
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let _ = current_user()?;
    db.with_raw(|c| {
        let mut stmt = c.prepare(
            "SELECT i.id, i.sku_code, i.barcode, i.name, i.brand, i.category, i.unit, i.units_per_pack, i.sell_unit, i.retail_price_paise, i.cost_paise, i.promo_price_paise, i.label_line1, i.label_line2, i.location_text, i.primary_location_id, i.min_qty, i.barcode_format, i.is_active, i.created_at, i.updated_at, COALESCE((SELECT SUM(qty) FROM stock_balances WHERE item_id = i.id), 0) AS current_qty FROM items i WHERE i.id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], row_to_item)?;
        rows.next()
            .ok_or_else(|| AppError::NotFound(format!("item {id}")))?
            .map_err(Into::into)
    })
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn lookup_item(state: State<'_, AppState>, code: String) -> AppResult<Option<ItemLookup>> {
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let user = current_user()?;
    // Search by barcode OR sku_code OR name match (best-effort).
    db.with_raw(|c| {
        let mut stmt = c.prepare(
            "SELECT i.id, i.sku_code, i.barcode, i.name, i.brand, i.category, i.unit, i.units_per_pack, i.sell_unit, i.retail_price_paise, i.cost_paise, i.promo_price_paise, i.label_line1, i.label_line2, i.location_text, i.primary_location_id, i.min_qty, i.barcode_format, i.is_active, i.created_at, i.updated_at, COALESCE((SELECT SUM(qty) FROM stock_balances WHERE item_id = i.id), 0) AS current_qty FROM items i WHERE (i.barcode = ?1 OR i.sku_code = ?1) AND i.is_active = 1 LIMIT 1",
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
                    location_text: item.location_text.clone(),
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
                    min_qty: item.min_qty,
                    location_text: item.location_text.clone(),
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
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let _ = current_user()?;
    db.with_raw(|c| {
        let (sell_unit, units_per_pack): (String, Option<i64>) = c.query_row(
            "SELECT sell_unit, units_per_pack FROM items WHERE id = ?1",
            params![item_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let base = to_base_units(qty, &sell_unit, units_per_pack);
        Ok(ConversionResult { qty, sell_unit, units_per_pack, qty_in_base_units: base })
    })
}

#[derive(Debug, Serialize)]
pub struct ConversionResult {
    pub qty: f64,
    pub sell_unit: String,
    pub units_per_pack: Option<i64>,
    pub qty_in_base_units: f64,
}

#[derive(Debug, Serialize, Clone)]
pub struct ItemSearchHit {
    pub id: i64,
    pub sku_code: String,
    pub barcode: Option<String>,
    pub name: String,
    pub brand: Option<String>,
    pub retail_price_paise: i64,
    pub sell_unit: String,
    pub unit: String,
    pub units_per_pack: Option<i64>,
    pub current_qty: i64,
}

pub fn search_items(db: &Db, query: &str, limit: i64) -> anyhow::Result<Vec<ItemSearchHit>> {
    let q = query.trim();
    db.with_raw(|c| {
        // Exact barcode/sku match wins first (scanner flow), then fuzzy name.
        let mut stmt = c.prepare(
            "SELECT i.id, i.sku_code, i.barcode, i.name, i.brand,
                    i.retail_price_paise, i.sell_unit, i.unit, i.units_per_pack,
                    COALESCE((SELECT SUM(qty) FROM stock_balances WHERE item_id = i.id), 0) AS q
             FROM items i
             WHERE i.is_active = 1
               AND (i.barcode = ?1 OR i.sku_code = ?1
                    OR i.name LIKE ?2 OR i.sku_code LIKE ?2 OR i.barcode LIKE ?2)
             ORDER BY
               CASE WHEN i.barcode = ?1 THEN 0
                    WHEN i.sku_code = ?1 THEN 1
                    WHEN i.name LIKE ?2 THEN 2
                    ELSE 3 END,
               i.name
             LIMIT ?3",
        )?;
        let like = format!("%{}%", q);
        let rows = stmt.query_map(params![q, like, limit], |r| {
            Ok(ItemSearchHit {
                id: r.get(0)?,
                sku_code: r.get(1)?,
                barcode: r.get(2)?,
                name: r.get(3)?,
                brand: r.get(4)?,
                retail_price_paise: r.get(5)?,
                sell_unit: r.get(6)?,
                unit: r.get(7)?,
                units_per_pack: r.get(8)?,
                current_qty: r.get(9)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
}

#[allow(dead_code)]
#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_search_items(
    state: State<'_, AppState>,
    query: String,
    limit: Option<i64>,
) -> AppResult<Vec<ItemSearchHit>> {
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let _ = current_user()?;
    search_items(db, &query, limit.unwrap_or(10)).map_err(|e| AppError::Internal(e.to_string()))
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
        unit: r.get(6)?,
        units_per_pack: r.get(7)?,
        sell_unit: r.get(8)?,
        retail_price_paise: r.get(9)?,
        cost_paise: r.get(10)?,
        promo_price_paise: r.get(11)?,
        label_line1: r.get(12)?,
        label_line2: r.get(13)?,
        location_text: r.get(14)?,
        primary_location_id: r.get(15)?,
        min_qty: r.get(16)?,
        barcode_format: r.get(17)?,
        is_active: r.get::<_, i64>(18)? != 0,
        created_at: r.get(19)?,
        updated_at: r.get(20)?,
        current_qty: r.get(21)?,
    })
}

fn fetch_item_tx(tx: &rusqlite::Connection, id: i64) -> AppResult<Item> {
    let mut stmt = tx.prepare(
        "SELECT i.id, i.sku_code, i.barcode, i.name, i.brand, i.category, i.unit, i.units_per_pack, i.sell_unit, i.retail_price_paise, i.cost_paise, i.promo_price_paise, i.label_line1, i.label_line2, i.location_text, i.primary_location_id, i.min_qty, i.barcode_format, i.is_active, i.created_at, i.updated_at, COALESCE((SELECT SUM(qty) FROM stock_balances WHERE item_id = i.id), 0) AS current_qty FROM items i WHERE i.id = ?1",
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
        assert_eq!(to_base_units(3.0, "box", Some(6)), 18.0);
        assert_eq!(to_base_units(3.0, "unit", Some(6)), 3.0);
        assert_eq!(to_base_units(2.0, "box", None), 2.0);
    }
}

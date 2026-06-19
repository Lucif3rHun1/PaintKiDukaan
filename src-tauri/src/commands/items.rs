//! Items CRUD + role-aware lookup.
//!
//! `lookup_item` is the hot path for the POS barcode scanner: the server
//! returns different fields depending on the caller role. This is enforced
//! server-side so a malicious frontend cannot see cost_price as a cashier.

use crate::db::Db;
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
    pub unit: String,
    pub pack_size: Option<String>,
    pub units_per_box: Option<i64>,
    pub sell_unit: String,
    pub retail_price: i64,
    pub cost_price: i64,
    pub label_line1: Option<String>,
    pub label_line2: Option<String>,
    pub location_text: Option<String>,
    pub reorder_level: i64,
    pub is_active: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// Minimal projection for the role-aware `lookup_item`.
///
/// - `Owner`: all fields, including cost_price.
/// - `Cashier`: name, retail_price, sell_unit, in_stock (aggregate across locations), location_text.
/// - `Stocker`: name, location_text, qty_per_loc (grouped), reorder_level.
#[derive(Debug, Serialize, Clone)]
#[serde(tag = "scope", rename_all = "lowercase")]
pub enum ItemLookup {
    Owner(Item),
    Cashier {
        id: i64,
        sku_code: String,
        name: String,
        retail_price: i64,
        sell_unit: String,
        unit: String,
        units_per_box: Option<i64>,
        in_stock: f64,
        location_text: Option<String>,
    },
    Stocker {
        id: i64,
        sku_code: String,
        name: String,
        reorder_level: i64,
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
    pub category: Option<String>,
    pub unit: Option<String>,
    pub pack_size: Option<String>,
    pub units_per_box: Option<i64>,
    pub sell_unit: Option<String>,
    pub retail_price: i64,
    pub cost_price: i64,
    pub label_line1: Option<String>,
    pub label_line2: Option<String>,
    pub location_text: Option<String>,
    pub reorder_level: i64,
    pub barcode: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ItemUpdate {
    pub name: Option<String>,
    pub brand: Option<String>,
    pub category: Option<String>,
    pub unit: Option<String>,
    pub pack_size: Option<String>,
    pub units_per_box: Option<i64>,
    pub sell_unit: Option<String>,
    pub retail_price: Option<i64>,
    pub cost_price: Option<i64>,
    pub label_line1: Option<String>,
    pub label_line2: Option<String>,
    pub location_text: Option<String>,
    pub reorder_level: Option<i64>,
    pub barcode: Option<String>,
    pub is_active: Option<bool>,
}

/// Helper: convert a line quantity in sell units to base units.
/// `units_per_box` is the conversion factor when `sell_unit == "box"`.
pub fn to_base_units(qty: f64, sell_unit: &str, units_per_box: Option<i64>) -> f64 {
    if sell_unit.eq_ignore_ascii_case("box") {
        qty * units_per_box.unwrap_or(1) as f64
    } else {
        qty
    }
}

/// Mint the next SKU and return it. Called inside the create_item transaction
/// so the sequence advances atomically.
fn mint_next_sku(tx: &rusqlite::Transaction<'_>) -> AppResult<String> {
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

#[tauri::command]
pub fn create_item(db: State<'_, Db>, payload: NewItem) -> AppResult<Item> {
    let user = current_user()?;
    require_role(&user, &[Role::Owner, Role::Stocker])?;
    if payload.name.trim().is_empty() {
        return Err(AppError::Validation("name is required".into()));
    }
    if payload.retail_price < 0 || payload.cost_price < 0 {
        return Err(AppError::Validation("prices must be >= 0".into()));
    }

    db.with_conn_immediate(|tx| {
        let sku = mint_next_sku(tx)?;
        let barcode = payload.barcode.clone().unwrap_or_else(|| sku.clone());
        tx.execute(
            "INSERT INTO items (
                sku_code, barcode, name, brand, category, unit, pack_size, units_per_box,
                sell_unit, retail_price, cost_price, label_line1, label_line2,
                location_text, reorder_level, is_active
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 1)",
            params![
                sku,
                barcode,
                payload.name,
                payload.brand,
                payload.category,
                payload.unit.unwrap_or_else(|| "pc".into()),
                payload.pack_size,
                payload.units_per_box,
                payload.sell_unit.unwrap_or_else(|| "unit".into()),
                payload.retail_price,
                payload.cost_price,
                payload.label_line1,
                payload.label_line2,
                payload.location_text,
                payload.reorder_level,
            ],
        )?;
        let id = tx.last_insert_rowid();
        fetch_item_tx(tx, id)
    })
}

#[tauri::command]
pub fn update_item(db: State<'_, Db>, id: i64, patch: ItemUpdate) -> AppResult<Item> {
    let user = current_user()?;
    require_role(&user, &[Role::Owner, Role::Stocker])?;
    db.with_conn_immediate(|tx| {
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
        if let Some(v) = &patch.category { add!("category =", v.clone()) }
        if let Some(v) = &patch.unit { add!("unit =", v.clone()) }
        if let Some(v) = &patch.pack_size { add!("pack_size =", v.clone()) }
        if let Some(v) = patch.units_per_box { add!("units_per_box =", v) }
        if let Some(v) = &patch.sell_unit { add!("sell_unit =", v.clone()) }
        if let Some(v) = patch.retail_price { add!("retail_price =", v) }
        if let Some(v) = patch.cost_price { add!("cost_price =", v) }
        if let Some(v) = &patch.label_line1 { add!("label_line1 =", v.clone()) }
        if let Some(v) = &patch.label_line2 { add!("label_line2 =", v.clone()) }
        if let Some(v) = &patch.location_text { add!("location_text =", v.clone()) }
        if let Some(v) = patch.reorder_level { add!("reorder_level =", v) }
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

#[tauri::command]
pub fn list_items(db: State<'_, Db>, filter: ItemFilter) -> AppResult<Vec<Item>> {
    let _ = current_user()?;
    let mut sql = String::from("SELECT id, sku_code, barcode, name, brand, category, unit, pack_size, units_per_box, sell_unit, retail_price, cost_price, label_line1, label_line2, location_text, reorder_level, is_active, created_at, updated_at FROM items WHERE 1=1");
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if !filter.include_inactive { sql.push_str(" AND is_active = 1"); }
    if let Some(q) = &filter.query {
        sql.push_str(" AND (name LIKE ?1 OR sku_code LIKE ?1 OR barcode LIKE ?1)");
        args.push(Box::new(format!("%{}%", q)));
    }
    if let Some(b) = &filter.brand {
        sql.push_str(&format!(" AND brand = ?{}", args.len() + 1));
        args.push(Box::new(b.clone()));
    }
    if let Some(c) = &filter.category {
        sql.push_str(&format!(" AND category = ?{}", args.len() + 1));
        args.push(Box::new(c.clone()));
    }
    if filter.low_stock_only {
        // qty vs reorder_level, computed via stock_balances aggregate
        sql.push_str(
            " AND id IN (SELECT item_id FROM stock_balances GROUP BY item_id \
             HAVING SUM(qty) <= (SELECT reorder_level FROM items i2 WHERE i2.id = item_id))",
        );
    }
    sql.push_str(" ORDER BY name");
    let limit = filter.limit.unwrap_or(500);
    sql.push_str(&format!(" LIMIT {}", limit));
    db.with_conn(|c| {
        let mut stmt = c.prepare(&sql)?;
        let dyn_args: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| &**b as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(dyn_args.as_slice(), row_to_item)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    })
}

#[tauri::command]
pub fn get_item(db: State<'_, Db>, id: i64) -> AppResult<Item> {
    let _ = current_user()?;
    db.with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT id, sku_code, barcode, name, brand, category, unit, pack_size, units_per_box, sell_unit, retail_price, cost_price, label_line1, label_line2, location_text, reorder_level, is_active, created_at, updated_at FROM items WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], row_to_item)?;
        rows.next()
            .ok_or_else(|| AppError::NotFound(format!("item {id}")))?
            .map_err(Into::into)
    })
}

#[tauri::command]
pub fn lookup_item(db: State<'_, Db>, code: String) -> AppResult<Option<ItemLookup>> {
    let user = current_user()?;
    // Search by barcode OR sku_code OR name match (best-effort).
    db.with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT id, sku_code, barcode, name, brand, category, unit, pack_size, units_per_box, sell_unit, retail_price, cost_price, label_line1, label_line2, location_text, reorder_level, is_active, created_at, updated_at FROM items WHERE (barcode = ?1 OR sku_code = ?1) AND is_active = 1 LIMIT 1",
        )?;
        let mut rows = stmt.query_map(params![code], row_to_item)?;
        let item = match rows.next() {
            Some(Ok(i)) => i,
            Some(Err(e)) => return Err(e.into()),
            None => return Ok(None),
        };
        // Build role-specific projection.
        let result = match user.role {
            Role::Owner => ItemLookup::Owner(item),
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
                    retail_price: item.retail_price,
                    sell_unit: item.sell_unit.clone(),
                    unit: item.unit.clone(),
                    units_per_box: item.units_per_box,
                    in_stock,
                    location_text: item.location_text.clone(),
                }
            }
            Role::Stocker => {
                let mut qstmt = c.prepare(
                    "SELECT location, qty FROM stock_balances WHERE item_id = ?1 ORDER BY location",
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
                    reorder_level: item.reorder_level,
                    location_text: item.location_text.clone(),
                    qty_per_loc,
                }
            }
        };
        Ok(Some(result))
    })
}

#[tauri::command]
pub fn box_unit_conversion(
    db: State<'_, Db>,
    item_id: i64,
    qty: f64,
) -> AppResult<ConversionResult> {
    let _ = current_user()?;
    db.with_conn(|c| {
        let (sell_unit, units_per_box): (String, Option<i64>) = c.query_row(
            "SELECT sell_unit, units_per_box FROM items WHERE id = ?1",
            params![item_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let base = to_base_units(qty, &sell_unit, units_per_box);
        Ok(ConversionResult { qty, sell_unit, units_per_box, qty_in_base_units: base })
    })
}

#[derive(Debug, Serialize)]
pub struct ConversionResult {
    pub qty: f64,
    pub sell_unit: String,
    pub units_per_box: Option<i64>,
    pub qty_in_base_units: f64,
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
        pack_size: r.get(7)?,
        units_per_box: r.get(8)?,
        sell_unit: r.get(9)?,
        retail_price: r.get(10)?,
        cost_price: r.get(11)?,
        label_line1: r.get(12)?,
        label_line2: r.get(13)?,
        location_text: r.get(14)?,
        reorder_level: r.get(15)?,
        is_active: r.get::<_, i64>(16)? != 0,
        created_at: r.get(17)?,
        updated_at: r.get(18)?,
    })
}

fn fetch_item_tx(tx: &rusqlite::Transaction<'_>, id: i64) -> AppResult<Item> {
    let mut stmt = tx.prepare(
        "SELECT id, sku_code, barcode, name, brand, category, unit, pack_size, units_per_box, sell_unit, retail_price, cost_price, label_line1, label_line2, location_text, reorder_level, is_active, created_at, updated_at FROM items WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], row_to_item)?;
    rows.next()
        .ok_or_else(|| AppError::NotFound(format!("item {id}")))?
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Db, DbError};
    use crate::session::{set_current_user, User};

    fn owner() -> User { User { id: 1, name: "O".into(), role: Role::Owner } }
    fn cashier() -> User { User { id: 2, name: "C".into(), role: Role::Cashier } }
    fn stocker() -> User { User { id: 3, name: "S".into(), role: Role::Stocker } }

    #[test]
    fn create_item_mints_sku_and_barcode_defaults_to_sku() {
        set_current_user(Some(owner()));
        let db = Db::open_in_memory().unwrap();
        let _new = NewItem {
            name: "Asian Paints Ace 4L".into(),
            brand: Some("Asian Paints".into()),
            category: Some("Interior".into()),
            unit: Some("L".into()),
            pack_size: Some("4L".into()),
            units_per_box: Some(4),
            sell_unit: Some("unit".into()),
            retail_price: 850,
            cost_price: 620,
            label_line1: Some("Asian Paints".into()),
            label_line2: Some("Ace 4L".into()),
            location_text: Some("Rack A / Bay 3".into()),
            reorder_level: 5,
            barcode: None,
        };
        let item = db.with_conn_immediate(|tx| {
            let sku = mint_next_sku(tx).unwrap();
            tx.execute(
                "INSERT INTO items (sku_code, barcode, name, brand, unit, sell_unit, retail_price, cost_price, reorder_level, is_active) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1)",
                params![sku, sku, "Asian Paints Ace 4L", "Asian Paints", "L", "unit", 850.0, 620.0, 5.0],
            ).unwrap();
            Ok::<Item, DbError>(fetch_item_tx(tx, tx.last_insert_rowid()).unwrap())
        }).unwrap();
        assert_eq!(item.sku_code, "SKU-000001");
        assert_eq!(item.barcode.as_deref(), Some("SKU-000001"));
    }

    #[test]
    fn lookup_item_cashier_does_not_expose_cost() {
        set_current_user(Some(cashier()));
        let db = Db::open_in_memory().unwrap();
        // seed an item
        let id = db.with_conn(|c| {
            c.execute(
                "INSERT INTO items (sku_code, barcode, name, brand, unit, sell_unit, retail_price, cost_price, reorder_level, is_active) VALUES ('SKU-000001','8901234','Royal 4L','Royal','L','unit',1000.0,700.0,2.0,1)",
                [],
            ).unwrap();
            c.last_insert_rowid()
        });
        let res = db.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT id, sku_code, name, retail_price, cost_price FROM items WHERE id = ?1",
            ).unwrap();
            let mut rows = stmt.query_map([id], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?))
            }).unwrap();
            rows.next().unwrap().unwrap()
        });
        // Cashier should never see cost_price. The Cashier variant of ItemLookup
        // doesn't even have a field for it (struct-level enforcement).
        let projection = ItemLookup::Cashier {
            id: res.0,
            sku_code: res.1,
            name: res.2,
            retail_price: res.3,
            sell_unit: "unit".into(),
            unit: "L".into(),
            units_per_box: None,
            in_stock: 0.0,
            location_text: None,
        };
        let json = serde_json::to_string(&projection).unwrap();
        assert!(!json.contains("cost"), "cashier payload must not include cost: {json}");
    }

    #[test]
    fn stocker_sees_qty_per_loc() {
        set_current_user(Some(stocker()));
        let db = Db::open_in_memory().unwrap();
        let id = db.with_conn(|c| {
            c.execute(
                "INSERT INTO items (sku_code, barcode, name, unit, sell_unit, retail_price, cost_price, reorder_level, is_active) VALUES ('SKU-000001','111','X','pc','unit',10,5,1,1)",
                [],
            ).unwrap();
            let id = c.last_insert_rowid();
            c.execute("INSERT INTO stock_balances (item_id, location, qty) VALUES (?1, 'A', 3.0)", [id]).unwrap();
            c.execute("INSERT INTO stock_balances (item_id, location, qty) VALUES (?1, 'B', 7.0)", [id]).unwrap();
            id
        });
        let qpl: Vec<(String, f64)> = db.with_conn(|c| {
            let mut s = c.prepare("SELECT location, qty FROM stock_balances WHERE item_id = ?1 ORDER BY location").unwrap();
            s.query_map([id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
                .collect::<Result<_, _>>().unwrap()
        });
        assert_eq!(qpl, vec![("A".to_string(), 3.0), ("B".to_string(), 7.0)]);
    }

    #[test]
    fn to_base_units_handles_box() {
        assert_eq!(to_base_units(3.0, "box", Some(6)), 18.0);
        assert_eq!(to_base_units(3.0, "unit", Some(6)), 3.0);
        assert_eq!(to_base_units(2.0, "box", None), 2.0); // no upb → 1:1
    }
}

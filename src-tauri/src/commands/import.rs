//! CSV import commands for items and purchases.
//!
//! Accepts raw CSV text from the frontend, parses it, validates each row,
//! and bulk-inserts. Returns a summary of successes, skips, and per-row errors.
//!
//! Items CSV columns (header required):
//!   name (required), sku, barcode, brand, category, unit, unit_code,
//!   units_per_pack, retail_price (rupees), cost_price (rupees),
//!   promo_price (rupees), min_stock, label_line1, label_line2,
//!   stock (optional — sets stock to exact value via adjustment movement)
//!
//! Purchases CSV columns (header required):
//!   item (name/sku/barcode, required), qty (required),
//!   cost_price (rupees, required), vendor (name, required),
//!   date (YYYY-MM-DD, optional), notes, location

use rusqlite::params;
use serde::Serialize;

use crate::commands::auth::AppState;
use crate::commands::sales::date_to_ms;
use crate::error::{AppError, AppResult};
use crate::security::ipc_auth;
use crate::session::{require_auth, require_role, Role};

// ── Public result types ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ImportResult {
    pub total_rows: usize,
    pub created: usize,
    pub skipped: usize,
    pub errors: Vec<ImportRowError>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportRowError {
    pub row: usize,
    pub message: String,
}

// ── CSV parser ─────────────────────────────────────────────────────────────
// Minimal RFC-4180-ish parser: handles commas, double-quoted fields, and
// escaped quotes (""). No external dependency.

/// Split a CSV line into fields, respecting double-quoted fields.
fn parse_csv_line(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if in_quotes {
            if c == '"' {
                if i + 1 < chars.len() && chars[i + 1] == '"' {
                    current.push('"');
                    i += 2;
                    continue;
                }
                in_quotes = false;
            } else {
                current.push(c);
            }
        } else if c == '"' {
            in_quotes = true;
        } else if c == ',' {
            fields.push(current.trim().to_string());
            current.clear();
        } else {
            current.push(c);
        }
        i += 1;
    }
    fields.push(current.trim().to_string());
    fields
}

/// Parse raw CSV text into (headers, rows). Skips empty lines.
fn parse_csv(raw: &str) -> (Vec<String>, Vec<Vec<String>>) {
    let mut lines: Vec<&str> = raw.lines().collect();
    // Strip BOM
    if let Some(first) = lines.first() {
        if first.starts_with('\u{feff}') {
            lines[0] = &first[3..];
        }
    }
    if lines.is_empty() {
        return (vec![], vec![]);
    }
    let headers = parse_csv_line(lines[0]);
    let mut rows = Vec::new();
    for line in &lines[1..] {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let fields = parse_csv_line(trimmed);
        if fields.iter().all(|f| f.is_empty()) {
            continue;
        }
        rows.push(fields);
    }
    (headers, rows)
}

/// Build a map from header name → column index (case-insensitive).
fn header_map(headers: &[String]) -> std::collections::HashMap<String, usize> {
    let mut map = std::collections::HashMap::new();
    for (i, h) in headers.iter().enumerate() {
        // Strip parenthetical annotations like "(₹)", "(or ...)" before normalizing
        let key = h.split('(').next().unwrap_or(h).trim().to_lowercase().replace(' ', "_");
        map.insert(key, i);
    }
    map
}

fn get_field(
    row: &[String],
    map: &std::collections::HashMap<String, usize>,
    keys: &[&str],
) -> Option<String> {
    for key in keys {
        if let Some(&idx) = map.get(*key) {
            if let Some(val) = row.get(idx) {
                let v = val.trim();
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

/// Parse a rupee amount string (e.g. "250", "250.50", "₹1,250", "Rs. 500/-") into paise.
fn parse_paise(s: &str) -> Option<i64> {
    let cleaned = s.trim()
        .replace(',', "")
        .replace("₹", "")
        .replace("Rs.", "")
        .replace("Rs", "")
        .replace("/-", "")
        .replace("INR", "")
        .trim()
        .to_string();
    if cleaned.is_empty() {
        return None;
    }
    if let Some(dot_pos) = cleaned.find('.') {
        let int_part = &cleaned[..dot_pos];
        let mut frac_part = &cleaned[dot_pos + 1..];
        if frac_part.len() > 2 {
            frac_part = &frac_part[..2];
        }
        let rupees: i64 = int_part.parse().ok()?;
        let paise: i64 = frac_part.parse().ok()?;
        Some(rupees * 100 + if rupees < 0 { -paise } else { paise })
    } else {
        let rupees: i64 = cleaned.parse().ok()?;
        Some(rupees * 100)
    }
}

// ── Items import ───────────────────────────────────────────────────────────

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_import_items_csv(
    state: tauri::State<'_, AppState>,
    csv_data: String,
) -> AppResult<ImportResult> {
    ipc_auth::authorize("cmd_import_items_csv", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let user = require_auth("cmd_import_items_csv", state.inner())?;
    require_role(&user, &[Role::Owner])?;

    let (headers, rows) = parse_csv(&csv_data);
    if headers.is_empty() {
        return Err(AppError::Validation("CSV has no headers".into()));
    }
    if rows.is_empty() {
        return Err(AppError::Validation("CSV has headers but no data rows".into()));
    }
    let hmap = header_map(&headers);

    // name is required
    if !hmap.contains_key("name") {
        return Err(AppError::Validation("CSV must have a 'name' column".into()));
    }

    let mut result = ImportResult {
        total_rows: rows.len(),
        created: 0,
        skipped: 0,
        errors: Vec::new(),
    };

    // Fetch existing locations (name → id, case-insensitive)
    let locations: std::collections::HashMap<String, i64> = db.with_raw(|c| {
        let mut stmt = c.prepare("SELECT id, name FROM locations WHERE is_active = 1")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, i64>(0)?)))?;
        let mut map = std::collections::HashMap::new();
        for r in rows {
            let (name, id) = r?;
            map.insert(name.to_lowercase(), id);
        }
        Ok::<_, AppError>(map)
    })?;

    // Fetch existing sub-locations (name → (id, location_id), case-insensitive)
    // (ponytail: removed — resolve_sub_location queries sub_locations per-row,
    //  which is fine for the small row counts CSV import handles)

    // Default location
    let default_location_id = locations
        .values()
        .next()
        .copied()
        .ok_or_else(|| AppError::Validation("no active locations — create at least one location before importing purchases".into()))?;

    let existing_items: Vec<ExistingItemRow> = db.with_raw(|c| {
        let mut stmt = c.prepare(
            "SELECT id, name, sku_code FROM items WHERE is_active = 1",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(ExistingItemRow {
                id: r.get(0)?,
                name: r.get(1)?,
                sku_code: r.get(2)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })?;

    db.with_tx(|tx| {
        for (i, row) in rows.iter().enumerate() {
            let row_num = i + 2; // 1-based, +1 for header

            // Extract name (required)
            let name = match get_field(row, &hmap, &["name", "item_name", "item"]) {
                Some(n) if !n.is_empty() => n,
                _ => {
                    result.errors.push(ImportRowError {
                        row: row_num,
                        message: "missing name".into(),
                    });
                    result.skipped += 1;
                    continue;
                }
            };
            let name = crate::commands::items::to_title_case(&name);

            // Optional fields
            let sku_code = get_field(row, &hmap, &["sku", "sku_code"]);
            let barcode = get_field(row, &hmap, &["barcode"]);
            let brand = get_field(row, &hmap, &["brand"]);
            let category = get_field(row, &hmap, &["category", "group"]);
            let unit_code_str = get_field(row, &hmap, &["unit", "unit_code"]).unwrap_or_else(|| "pc".into());
            let units_per_pack = get_field(row, &hmap, &["units_per_pack", "pack_size"])
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(1.0);
            let sell_unit = get_field(row, &hmap, &["sell_unit", "sell"]);

            let retail_price_paise = match get_field(row, &hmap, &["retail_price", "retail", "mrp", "selling_price", "price"]) {
                Some(s) => match parse_paise(&s) {
                    Some(v) => v,
                    None => {
                        result.errors.push(ImportRowError { row: row_num, message: format!("unparseable retail_price: \"{s}\"") });
                        result.skipped += 1;
                        continue;
                    }
                },
                None => 0,
            };
            let cost_price_paise = match get_field(row, &hmap, &["cost_price", "cost", "purchase_price", "buying_price"]) {
                Some(s) => match parse_paise(&s) {
                    Some(v) => v,
                    None => {
                        result.errors.push(ImportRowError { row: row_num, message: format!("unparseable cost_price: \"{s}\"") });
                        result.skipped += 1;
                        continue;
                    }
                },
                None => 0,
            };
            let promo_price_paise = get_field(row, &hmap, &["promo_price", "promo", "offer_price"])
                .and_then(|s| parse_paise(&s));
            let min_stock = get_field(row, &hmap, &["min_qty", "min_stock", "reorder_level", "minimum"])
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(0.0);
            let label_line1 = get_field(row, &hmap, &["label_line1", "label1"]);
            let label_line2 = get_field(row, &hmap, &["label_line2", "label2"]);

            // Location resolution
            let primary_location_name =
                get_field(row, &hmap, &["primary_location", "location", "location_name"]);
            let primary_location_id =
                resolve_primary_location(tx, primary_location_name.as_deref(), default_location_id)?;

            let position = get_field(row, &hmap, &["position", "pos", "shelf"]);
            let sub_location_name = get_field(row, &hmap, &["sub_location", "sub", "rack"]);
            let sub_location_id = resolve_sub_location(
                tx,
                primary_location_id,
                sub_location_name.as_deref(),
                position.as_deref(),
            )?;
            let stock_qty = get_field(row, &hmap, &["stock", "qty", "quantity", "stock_qty", "current_stock", "inventory"])
                .and_then(|s| s.parse::<f64>().ok());

            // Validate
            if retail_price_paise < 0 || cost_price_paise < 0 {
                result.errors.push(ImportRowError {
                    row: row_num,
                    message: "prices must be >= 0".into(),
                });
                result.skipped += 1;
                continue;
            }

            // Resolve brand_id
            let brand_id = resolve_brand(tx, brand.as_deref())?;

            // Resolve sell_unit_id if sell_unit is provided
            let sell_unit_id: Option<i64> = if let Some(ref su) = sell_unit {
                let sid = tx.query_row(
                    "SELECT id FROM sale_units WHERE LOWER(code) = LOWER(?1) AND is_active = 1",
                    params![su],
                    |r| r.get(0),
                );
                sid.ok()
            } else {
                None
            };

            let now_ms = chrono::Utc::now().timestamp_millis();

            // Check if item exists by SKU (exact match) or by name (exact match)
            let existing_id = if let Some(ref sku) = sku_code {
                // SKU match — SKU is immutable, only update fields
                existing_items.iter().find(|it| it.sku_code.to_lowercase() == sku.to_lowercase()).map(|it| it.id)
            } else {
                // No SKU provided — match by exact name (case-insensitive)
                existing_items.iter().find(|it| it.name.to_lowercase() == name.to_lowercase()).map(|it| it.id)
            };

            let mut processed_item_id: Option<i64> = None;
            if let Some(item_id) = existing_id {
                // ── UPSERT: update existing item's mutable fields ──
                // SKU is never overwritten; barcode is kept if already set
                let final_barcode = match tx.query_row(
                    "SELECT barcode FROM items WHERE id = ?1",
                    params![item_id],
                    |r| r.get::<_, Option<String>>(0),
                ) {
                    Ok(Some(existing)) => existing,
                    Ok(None) | Err(rusqlite::Error::QueryReturnedNoRows) => {
                        match barcode.or(sku_code.clone()) {
                            Some(value) => value,
                            None => auto_sku(tx)?,
                        }
                    }
                    Err(e) => return Err(AppError::from(e)),
                };

                tx.execute(
                    "UPDATE items SET
                        barcode = ?1,
                        name = ?2,
                        brand_id = ?3,
                        category = ?4,
                        unit_code = ?5,
                        unit_label = ?6,
                        units_per_pack = ?7,
                        sell_unit = ?8,
                        sell_unit_id = ?9,
                        retail_price_paise = ?10,
                        cost_paise = ?11,
                        promo_price_paise = ?12,
                        label_line1 = ?13,
                        label_line2 = ?14,
                        primary_location_id = ?15,
                        sub_location_id = ?16,
                        position = ?17,
                        min_stock = ?18,
                        updated_at = ?19
                     WHERE id = ?20",
                    params![
                        final_barcode,
                        name,
                        brand_id,
                        category,
                        unit_code_str,
                        unit_code_str,
                        units_per_pack,
                        sell_unit,
                        sell_unit_id,
                        retail_price_paise,
                        cost_price_paise,
                        promo_price_paise,
                        label_line1,
                        label_line2,
                        primary_location_id,
                        sub_location_id,
                        position,
                        min_stock,
                        now_ms,
                        item_id,
                    ],
                )?;
                processed_item_id = Some(item_id);
                result.created += 1; // counts as "processed"
            } else {
                // ── INSERT: new item ──
                let final_sku = match sku_code {
                    Some(sku) => sku,
                    None => auto_sku(tx)?,
                };
                let final_barcode = barcode.unwrap_or_else(|| final_sku.clone());
                let barcode_format = "CODE128";

                match tx.execute(
                    "INSERT INTO items (
                        sku_code, barcode, name, brand_id, category, unit_code, unit_label,
                        units_per_pack, sell_unit, sell_unit_id,
                        retail_price_paise, cost_paise, promo_price_paise,
                        label_line1, label_line2, primary_location_id,
                        sub_location_id, position, min_stock, barcode_format, is_active,
                        created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, 1, ?21, ?21)",
                    params![
                        final_sku,
                        final_barcode,
                        name,
                        brand_id,
                        category,
                        unit_code_str,
                        unit_code_str,
                        units_per_pack,
                        sell_unit,
                        sell_unit_id,
                        retail_price_paise,
                        cost_price_paise,
                        promo_price_paise,
                        label_line1,
                        label_line2,
                        primary_location_id,
                        sub_location_id,
                        position,
                        min_stock,
                        barcode_format,
                        now_ms,
                    ],
                ) {
                    Ok(_) => {
                        processed_item_id = Some(tx.last_insert_rowid());
                        result.created += 1;
                    }
                    Err(e) => {
                        result.errors.push(ImportRowError {
                            row: row_num,
                            message: import_db_error_message(&e),
                        });
                        result.skipped += 1;
                    }
                }
            }

            if let (Some(item_id), Some(target_stock)) = (processed_item_id, stock_qty) {
                let current_balance: f64 = tx.query_row(
                    "SELECT COALESCE(SUM(qty), 0.0) FROM stock_balances WHERE item_id = ?1",
                    params![item_id],
                    |r| r.get(0),
                ).unwrap_or(0.0);
                let delta = target_stock - current_balance;
                if delta.abs() > f64::EPSILON {
                    if let Err(e) = tx.execute(
                        "INSERT INTO stock_movements (item_id, location_id, qty, kind_id, sale_unit_id, ref_kind, ref_id, note, created_at, created_by)
                         VALUES (?1, ?2, ?3, (SELECT id FROM stock_movement_kinds WHERE code='adjustment'), COALESCE((SELECT sell_unit_id FROM items WHERE id = ?1), (SELECT id FROM sale_units WHERE code = 'pcs')), 'adjustment', NULL, ?4, ?5, ?6)",
                        params![
                            item_id,
                            primary_location_id,
                            delta,
                            "Stock set by CSV import",
                            now_ms,
                            user.id,
                        ],
                    ) {
                        log::warn!("stock replacement failed for item {item_id}: {e}");
                        result.errors.push(ImportRowError { row: i + 2, message: format!("stock adjustment failed for item {item_id}: {e}") });
                    }
                }
            }
        }
        Ok::<(), AppError>(())
    })?;

    Ok(result)
}


fn auto_sku(tx: &rusqlite::Connection) -> AppResult<String> {
    let n: i64 = tx
        .query_row(
            "INSERT INTO sequences(name, value) VALUES ('sku', 1)
             ON CONFLICT(name) DO UPDATE SET value = value + 1
             RETURNING value",
            [],
            |r| r.get(0),
        )?;
    Ok(format!("SKU-{n:06}"))
}

fn resolve_primary_location(
    conn: &rusqlite::Connection,
    name: Option<&str>,
    default_id: i64,
) -> AppResult<i64> {
    match name {
        Some(n) => conn
            .query_row(
                "SELECT id FROM locations WHERE LOWER(name) = LOWER(?1) AND is_active = 1",
                params![n],
                |r| r.get::<_, i64>(0),
            )
            .map_err(|_| AppError::Validation(format!("primary location '{n}' does not exist"))),
        None => Ok(default_id),
    }
}

fn resolve_sub_location(
    conn: &rusqlite::Connection,
    parent_id: i64,
    name: Option<&str>,
    position: Option<&str>,
) -> AppResult<Option<i64>> {
    let Some(name) = name else {
        return Ok(None);
    };
    let Some(pos) = position else {
        return Err(AppError::Validation(format!(
            "sub_location '{name}' requires a position"
        )));
    };
    if let Ok(id) = conn.query_row(
        "SELECT id FROM sub_locations \
         WHERE LOWER(name) = LOWER(?1) AND location_id = ?2 AND is_active = 1",
        params![name, parent_id],
        |r| r.get::<_, i64>(0),
    ) {
        return Ok(Some(id));
    }
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO sub_locations (location_id, name, position, is_active, created_at, updated_at) \
         VALUES (?1, ?2, ?3, 1, ?4, ?4)",
        params![parent_id, name, pos, now],
    )?;
    Ok(Some(conn.last_insert_rowid()))
}

fn resolve_brand(
    conn: &rusqlite::Connection,
    name: Option<&str>,
) -> AppResult<Option<i64>> {
    let Some(name) = name else {
        return Ok(None);
    };
    if let Ok(id) = conn.query_row(
        "SELECT id FROM brands WHERE LOWER(name) = LOWER(?1) AND is_active = 1",
        params![name],
        |r| r.get::<_, i64>(0),
    ) {
        return Ok(Some(id));
    }
    let prefix = crate::commands::items::make_name_abbreviation(name);
    if prefix.is_empty() {
        return Err(AppError::Validation(format!(
            "cannot derive prefix for brand '{name}'"
        )));
    }
    let collision: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM brands WHERE prefix = ?1 AND is_active = 1",
            params![prefix],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if collision > 0 {
        return Err(AppError::Validation(format!(
            "brand '{name}' would derive prefix '{prefix}' which is already owned by another brand"
        )));
    }
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO brands (name, prefix, is_active, created_at, updated_at) \
         VALUES (?1, ?2, 1, ?3, ?3)",
        params![name, prefix, now],
    )?;
    let id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO brand_sequences (brand_id, prefix, next_seq, padding, updated_at) \
         VALUES (?1, ?2, 1, 4, ?3)",
        params![id, prefix, now],
    )?;
    Ok(Some(id))
}

fn import_db_error_message(e: &rusqlite::Error) -> String {
    match e {
        rusqlite::Error::SqliteFailure(_, Some(detail))
            if detail.to_lowercase().contains("unique") =>
        {
            "duplicate item data — check SKU, barcode, and name".into()
        }
        rusqlite::Error::SqliteFailure(_, _) => "database constraint violation".into(),
        _ => "database error while importing row".into(),
    }
}

// ── Purchases (inward) import ──────────────────────────────────────────────

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_import_inward_csv(
    state: tauri::State<'_, AppState>,
    csv_text: String,
) -> AppResult<ImportResult> {
    ipc_auth::authorize("cmd_import_inward_csv", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let user = require_auth("cmd_import_inward_csv", state.inner())?;
    require_role(&user, &[Role::Owner])?;

    let (headers, rows) = parse_csv(&csv_text);
    if headers.is_empty() {
        return Err(AppError::Validation("CSV has no headers".into()));
    }
    if rows.is_empty() {
        return Err(AppError::Validation("CSV has headers but no data rows".into()));
    }
    let hmap = header_map(&headers);

    // item and qty are required
    if !hmap.contains_key("item")
        && !hmap.contains_key("item_name")
        && !hmap.contains_key("item_id")
        && !hmap.contains_key("sku")
        && !hmap.contains_key("sku_code")
    {
        return Err(AppError::Validation(
            "CSV must have an 'item' column (name, SKU, or barcode)".into(),
        ));
    }
    if !hmap.contains_key("qty") && !hmap.contains_key("quantity") {
        return Err(AppError::Validation("CSV must have a 'qty' column".into()));
    }

    let mut result = ImportResult {
        total_rows: rows.len(),
        created: 0,
        skipped: 0,
        errors: Vec::new(),
    };

    // Fetch default location
    let default_location_id = db.with_raw(|c| {
        c.query_row(
            "SELECT id FROM locations WHERE is_active = 1 ORDER BY is_default DESC, id LIMIT 1",
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(1)
    });

    // Pre-fetch items for name/SKU/barcode lookup
    let all_items: Vec<ItemLookupRow> = db.with_raw(|c| {
        let mut stmt = c.prepare(
            "SELECT id, name, sku_code, barcode, sell_unit_id, unit_code, units_per_pack, cost_paise, retail_price_paise FROM items WHERE is_active = 1",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(ItemLookupRow {
                id: r.get(0)?,
                name: r.get(1)?,
                sku_code: r.get(2)?,
                barcode: r.get(3)?,
                sell_unit_id: r.get(4)?,
                _unit_code: r.get(5)?,
                units_per_pack: r.get(6)?,
                cost_paise: r.get(7)?,
                _retail_price_paise: r.get(8)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })?;

    db.with_tx(|tx| {
        for (i, row) in rows.iter().enumerate() {
            let row_num = i + 2;

            // Resolve item
            let item_ref = get_field(row, &hmap, &["item", "item_name", "item_id", "sku", "sku_code", "barcode"]);
            let item = match item_ref {
                Some(ref q) => resolve_item(&all_items, q),
                None => {
                    result.errors.push(ImportRowError {
                        row: row_num,
                        message: "missing item".into(),
                    });
                    result.skipped += 1;
                    continue;
                }
            };
            let item = match item {
                Some(it) => it,
                None => {
                    result.errors.push(ImportRowError {
                        row: row_num,
                        message: format!("item '{}' not found", item_ref.unwrap_or_else(|| "unknown".into())),
                    });
                    result.skipped += 1;
                    continue;
                }
            };

            // Qty
            let qty_str = get_field(row, &hmap, &["qty", "quantity"]);
            let qty: f64 = match qty_str.as_deref() {
                Some(s) => s.trim().replace(',', "").parse().unwrap_or(0.0),
                None => 0.0,
            };
            if qty <= 0.0 || qty.is_nan() {
                result.errors.push(ImportRowError {
                    row: row_num,
                    message: "qty must be > 0".into(),
                });
                result.skipped += 1;
                continue;
            }

            // Cost price
            let cost_paise = match get_field(row, &hmap, &["cost_price", "cost", "price", "unit_price"]) {
                Some(s) => parse_paise(&s).unwrap_or(item.cost_paise),
                None => item.cost_paise,
            };
            if cost_paise < 0 {
                result.errors.push(ImportRowError {
                    row: row_num,
                    message: "cost must be >= 0".into(),
                });
                result.skipped += 1;
                continue;
            }

            // Vendor (required)
            let vendor_name = get_field(row, &hmap, &["vendor", "vendor_name", "supplier"]);
            let vendor_id = match vendor_name {
                Some(ref vn) => {
                    // Look up or create vendor
                    let vid = tx.query_row(
                        "SELECT id FROM vendors WHERE LOWER(name) = LOWER(?1) AND is_active = 1",
                        params![vn],
                        |r| r.get::<_, i64>(0),
                    );
                    match vid {
                        Ok(id) => id,
                        Err(_) => {
                            // Create vendor on the fly
                            let now = chrono::Utc::now().timestamp_millis();
                            match tx.execute(
                                "INSERT INTO vendors (name, opening_balance_paise, is_active, created_at, updated_at) VALUES (?1, 0, 1, ?2, ?2)",
                                params![vn, now],
                            ) {
                                Ok(_) => tx.last_insert_rowid(),
                                Err(e) => {
                                    result.errors.push(ImportRowError {
                                        row: row_num,
                                        message: format!("failed to create vendor '{}': {}", vn, e),
                                    });
                                    result.skipped += 1;
                                    continue;
                                }
                            }
                        }
                    }
                }
                None => {
                    result.errors.push(ImportRowError {
                        row: row_num,
                        message: "missing vendor".into(),
                    });
                    result.skipped += 1;
                    continue;
                }
            };

            // Date
            let date_str = get_field(row, &hmap, &["date", "bill_date"])
                .unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d").to_string());
            let bill_date = date_to_ms(&date_str);

            // Location
            let location_id = get_field(row, &hmap, &["location", "location_id"])
                .and_then(|s| s.parse::<i64>().ok())
                .unwrap_or(default_location_id);

            // Notes
            let notes = get_field(row, &hmap, &["notes", "note", "remarks"]);

            // Compute base qty
            let base = crate::commands::purchases::base_qty(qty, "pcs", item.units_per_pack as f64);
            let line_total = (base * cost_paise as f64).round() as i64;

            // Create purchase
            let now_ms = chrono::Utc::now().timestamp_millis();
            let purchase_number = {
                let next_id_opt: Option<i64> = tx
                    .query_row(
                        "INSERT INTO daily_counters(prefix, date, last_serial)
                         VALUES ('PINV', '', 1)
                         ON CONFLICT(prefix, date) DO UPDATE SET last_serial = last_serial + 1
                         RETURNING last_serial",
                        [],
                        |r| r.get(0),
                    )
                    .ok();
                let Some(next_id) = next_id_opt else {
                    result.errors.push(ImportRowError {
                        row: row_num,
                        message: "Failed to generate purchase number".into(),
                    });
                    result.skipped += 1;
                    continue;
                };
                format!("PINV-{next_id:04}")
            };

            match tx.execute(
                "INSERT INTO purchases (purchase_number, vendor_id, location_id, total_paise, created_by, notes, bill_date, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![purchase_number, vendor_id, location_id, line_total, user.id, notes, bill_date, now_ms, now_ms],
            ) {
                Ok(_) => {}
                Err(e) => {
                    result.errors.push(ImportRowError {
                        row: row_num,
                        message: format!("DB error creating purchase: {}", e),
                    });
                    result.skipped += 1;
                    continue;
                }
            }
            let pid = tx.last_insert_rowid();

            // Insert purchase_item
            if let Err(e) = tx.execute(
                "INSERT INTO purchase_items (purchase_id, item_id, qty, sale_unit_id, unit_price_paise, line_discount_paise, line_total_paise, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7)",
                params![pid, item.id, base, item.sell_unit_id, cost_paise, line_total, now_ms],
            ) {
                result.errors.push(ImportRowError {
                    row: row_num,
                    message: format!("DB error creating line: {}", e),
                });
                // Rollback orphan purchase row (transaction still open)
                let _ = tx.execute("DELETE FROM purchases WHERE id = ?1", params![pid]);
                continue;
            }

            // Insert stock movement
            tx.execute(
                "INSERT INTO stock_movements (item_id, location_id, qty, kind_id, sale_unit_id, ref_kind, ref_id, note, created_at, created_by)
                 VALUES (?1, ?2, ?3, (SELECT id FROM stock_movement_kinds WHERE code='purchase'), ?4, 'purchase', ?5, ?6, ?7, ?8)",
                params![item.id, location_id, base, item.sell_unit_id, pid, notes, now_ms, user.id],
            )?;

            result.created += 1;
        }
        Ok::<(), AppError>(())
    })?;

    Ok(result)
}

struct ExistingItemRow {
    id: i64,
    name: String,
    sku_code: String,
}

struct ItemLookupRow {
    id: i64,
    name: String,
    sku_code: String,
    barcode: Option<String>,
    sell_unit_id: i64,
    _unit_code: String,
    units_per_pack: f64,
    cost_paise: i64,
    _retail_price_paise: i64,
}

/// Resolve an item by name (case-insensitive), then SKU, then barcode.
fn resolve_item<'a>(items: &'a [ItemLookupRow], query: &str) -> Option<&'a ItemLookupRow> {
    let q = query.trim().to_lowercase();
    // Exact name match
    if let Some(it) = items.iter().find(|it| it.name.to_lowercase() == q) {
        return Some(it);
    }
    // SKU match
    if let Some(it) = items.iter().find(|it| it.sku_code.to_lowercase() == q) {
        return Some(it);
    }
    // Barcode match
    if let Some(it) = items
        .iter()
        .find(|it| it.barcode.as_deref().map(|b| b.to_lowercase()) == Some(q.clone()))
    {
        return Some(it);
    }
    // Partial name match
    items.iter().find(|it| it.name.to_lowercase().contains(&q))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn seed_location(c: &rusqlite::Connection, name: &str, is_default: bool) -> i64 {
        let now = chrono::Utc::now().timestamp_millis();
        c.execute(
            "INSERT INTO locations (name, is_default, is_active, created_at, updated_at) \
             VALUES (?1, ?2, 1, ?3, ?3)",
            params![name, is_default as i64, now],
        )
        .unwrap();
        c.last_insert_rowid()
    }

    fn seed_sub_location(c: &rusqlite::Connection, parent: i64, name: &str, position: &str) -> i64 {
        let now = chrono::Utc::now().timestamp_millis();
        c.execute(
            "INSERT INTO sub_locations (location_id, name, position, is_active, created_at, updated_at) \
             VALUES (?1, ?2, ?3, 1, ?4, ?4)",
            params![parent, name, position, now],
        )
        .unwrap();
        c.last_insert_rowid()
    }

    fn seed_brand(c: &rusqlite::Connection, name: &str, prefix: &str) -> i64 {
        let now = chrono::Utc::now().timestamp_millis();
        c.execute(
            "INSERT INTO brands (name, prefix, is_active, created_at, updated_at) \
             VALUES (?1, ?2, 1, ?3, ?3)",
            params![name, prefix, now],
        )
        .unwrap();
        c.last_insert_rowid()
    }

    #[test]
    fn primary_location_found_returns_id() {
        let db = Db::open_in_memory().unwrap();
        db.with_raw(|c| {
            let id = seed_location(c, "MainShop", true);
            assert_eq!(resolve_primary_location(c, Some("MainShop"), 999).unwrap(), id);
        });
    }

    #[test]
    fn primary_location_missing_errors() {
        let db = Db::open_in_memory().unwrap();
        db.with_raw(|c| {
            seed_location(c, "MainShop", true);
            let err = resolve_primary_location(c, Some("NonexistentShop"), 999).unwrap_err();
            assert!(err.to_string().contains("does not exist"));
        });
    }

    #[test]
    fn primary_location_none_uses_default() {
        let db = Db::open_in_memory().unwrap();
        db.with_raw(|c| {
            assert_eq!(resolve_primary_location(c, None, 42).unwrap(), 42);
        });
    }

    #[test]
    fn sub_location_create_with_position() {
        let db = Db::open_in_memory().unwrap();
        db.with_raw(|c| {
            let parent = seed_location(c, "MainShop", true);
            let id = resolve_sub_location(c, parent, Some("Rack-7"), Some("A1"))
                .unwrap()
                .expect("id");
            let stored: String = c
                .query_row("SELECT name FROM sub_locations WHERE id = ?1", params![id], |r| r.get(0))
                .unwrap();
            assert_eq!(stored, "Rack-7");
        });
    }

    #[test]
    fn sub_location_existing_returns_id() {
        let db = Db::open_in_memory().unwrap();
        db.with_raw(|c| {
            let parent = seed_location(c, "MainShop", true);
            let existing = seed_sub_location(c, parent, "Rack-1", "A1");
            let resolved = resolve_sub_location(c, parent, Some("Rack-1"), Some("A1"))
                .unwrap()
                .expect("id");
            assert_eq!(resolved, existing);
        });
    }

    #[test]
    fn sub_location_without_position_errors() {
        let db = Db::open_in_memory().unwrap();
        db.with_raw(|c| {
            let parent = seed_location(c, "MainShop", true);
            let err = resolve_sub_location(c, parent, Some("Rack-7"), None).unwrap_err();
            assert!(err.to_string().contains("requires a position"));
        });
    }

    #[test]
    fn brand_existing_returns_id() {
        let db = Db::open_in_memory().unwrap();
        db.with_raw(|c| {
            let resolved = resolve_brand(c, Some("Berger Paints")).unwrap();
            assert!(resolved.is_some(), "Berger Paints is pre-seeded by schema_final.sql");
        });
    }

    #[test]
    fn brand_new_auto_creates_with_derived_prefix() {
        let db = Db::open_in_memory().unwrap();
        db.with_raw(|c| {
            let id = resolve_brand(c, Some("Foo Bar")).unwrap().expect("id");
            let prefix: String = c
                .query_row("SELECT prefix FROM brands WHERE id = ?1", params![id], |r| r.get(0))
                .unwrap();
            // make_name_abbreviation("Foo Bar") → "FOOB" (first word "Foo"→"FOO", second "Bar"→"B" → break at 4)
            assert_eq!(prefix, "FOOB");
        });
    }

    #[test]
    fn brand_prefix_conflict_errors() {
        let db = Db::open_in_memory().unwrap();
        db.with_raw(|c| {
            seed_brand(c, "Apple Inc", "APP");
            let err = resolve_brand(c, Some("Apple")).unwrap_err();
            assert!(err.to_string().contains("already owned"));
        });
    }
}

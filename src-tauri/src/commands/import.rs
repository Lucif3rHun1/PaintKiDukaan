//! CSV import commands for items and purchases.
//!
//! Accepts raw CSV text from the frontend, parses it, validates each row,
//! and bulk-inserts. Returns a summary of successes, skips, and per-row errors.
//!
//! Items CSV columns (header required):
//!   name (required), sku, barcode, brand, category, unit, unit_code,
//!   units_per_pack, retail_price (rupees), cost_price (rupees),
//!   promo_price (rupees), min_qty, label_line1, label_line2
//!
//! Purchases CSV columns (header required):
//!   item (name/sku/barcode, required), qty (required),
//!   cost_price (rupees, required), vendor (name, required),
//!   date (YYYY-MM-DD, optional), notes, location

use rusqlite::params;
use serde::Serialize;

use crate::commands::auth::AppState;
use crate::error::{AppError, AppResult};
use crate::security::ipc_auth;
use crate::session::{current_user, require_role, Role};

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
        map.insert(h.to_lowercase().replace(' ', "_"), i);
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

/// Parse a rupee amount string (e.g. "250", "250.50") into paise.
fn parse_paise(s: &str) -> Option<i64> {
    let trimmed = s.trim().replace(',', "");
    if trimmed.is_empty() {
        return None;
    }
    if let Some(dot_pos) = trimmed.find('.') {
        let int_part = &trimmed[..dot_pos];
        let mut frac_part = &trimmed[dot_pos + 1..];
        if frac_part.len() > 2 {
            frac_part = &frac_part[..2];
        }
        let rupees: i64 = int_part.parse().ok()?;
        let paise: i64 = frac_part.parse().ok()?;
        Some(rupees * 100 + if rupees < 0 { -paise } else { paise })
    } else {
        let rupees: i64 = trimmed.parse().ok()?;
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
    let user = current_user()?;
    require_role(&user, &[Role::Owner, Role::Stocker])?;

    let (headers, rows) = parse_csv(&csv_data);
    if headers.is_empty() {
        return Err(AppError::Validation("CSV has no headers".into()));
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

    // Fetch existing units for lookup
    let units: std::collections::HashMap<String, i64> = db.with_raw(|c| {
        let mut stmt = c.prepare("SELECT id, code FROM units WHERE is_active = 1")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, i64>(0)?)))?;
        let mut map = std::collections::HashMap::new();
        for r in rows {
            let (code, id) = r?;
            map.insert(code.to_lowercase(), id);
        }
        Ok::<_, AppError>(map)
    })?;

    // Default unit
    let default_unit_id = units
        .get("pc")
        .copied()
        .or_else(|| units.values().next().copied())
        .unwrap_or(1);

    // Fetch existing locations
    let default_location_id = db.with_raw(|c| {
        c.query_row(
            "SELECT id FROM locations WHERE is_active = 1 ORDER BY is_default DESC, id LIMIT 1",
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(1)
    });

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

            // Optional fields
            let sku_code = get_field(row, &hmap, &["sku", "sku_code"])
                .unwrap_or_else(|| auto_sku(tx));
            let barcode = get_field(row, &hmap, &["barcode"]);
            let brand = get_field(row, &hmap, &["brand"]);
            let category = get_field(row, &hmap, &["category", "group"]);
            let unit_code_str = get_field(row, &hmap, &["unit", "unit_code"]).unwrap_or_else(|| "pc".into());
            let unit_id = units.get(&unit_code_str.to_lowercase()).copied().unwrap_or(default_unit_id);
            let units_per_pack = get_field(row, &hmap, &["units_per_pack", "pack_size"])
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(1.0);

            let retail_price_paise = match get_field(row, &hmap, &["retail_price", "retail", "mrp", "selling_price", "price"]) {
                Some(s) => parse_paise(&s).unwrap_or(0),
                None => 0,
            };
            let cost_price_paise = match get_field(row, &hmap, &["cost_price", "cost", "purchase_price", "buying_price"]) {
                Some(s) => parse_paise(&s).unwrap_or(0),
                None => 0,
            };
            let promo_price_paise = get_field(row, &hmap, &["promo_price", "promo", "offer_price"])
                .and_then(|s| parse_paise(&s));
            let min_qty = get_field(row, &hmap, &["min_qty", "reorder_level", "minimum"])
                .and_then(|s| s.parse::<i64>().ok())
                .unwrap_or(0);
            let label_line1 = get_field(row, &hmap, &["label_line1", "label1"]);
            let label_line2 = get_field(row, &hmap, &["label_line2", "label2"]);

            let location_id = default_location_id;

            // Validate
            if retail_price_paise < 0 || cost_price_paise < 0 {
                result.errors.push(ImportRowError {
                    row: row_num,
                    message: "prices must be >= 0".into(),
                });
                result.skipped += 1;
                continue;
            }

            // Check for duplicate barcode
            if let Some(ref bc) = barcode {
                let exists: bool = tx
                    .query_row(
                        "SELECT COUNT(*) > 0 FROM items WHERE barcode = ?1",
                        params![bc],
                        |r| r.get(0),
                    )
                    .unwrap_or(false);
                if exists {
                    result.errors.push(ImportRowError {
                        row: row_num,
                        message: format!("barcode '{}' already exists", bc),
                    });
                    result.skipped += 1;
                    continue;
                }
            }

            // Check for duplicate SKU
            let sku_exists: bool = tx
                .query_row(
                    "SELECT COUNT(*) > 0 FROM items WHERE sku_code = ?1",
                    params![sku_code],
                    |r| r.get(0),
                )
                .unwrap_or(false);
            if sku_exists {
                result.errors.push(ImportRowError {
                    row: row_num,
                    message: format!("SKU '{}' already exists", sku_code),
                });
                result.skipped += 1;
                continue;
            }

            let final_barcode = barcode.unwrap_or_else(|| sku_code.clone());
            let barcode_format = "CODE128";

            // Resolve brand_id if brand name is provided
            let brand_id: Option<i64> = if let Some(ref bname) = brand {
                let bid = tx.query_row(
                    "SELECT id FROM brands WHERE LOWER(name) = LOWER(?1) AND is_active = 1",
                    params![bname],
                    |r| r.get(0),
                );
                bid.ok()
            } else {
                None
            };

            let now_ms = chrono::Utc::now().timestamp_millis();

            match tx.execute(
                "INSERT INTO items (
                    sku_code, barcode, name, brand_id, category, unit_id, unit_code, unit_label,
                    units_per_pack, retail_price_paise, cost_paise, promo_price_paise,
                    label_line1, label_line2, primary_location_id,
                    sub_location_id, position, min_qty, barcode_format, is_active,
                    created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, 1, ?20, ?20)",
                params![
                    sku_code,
                    final_barcode,
                    name,
                    brand_id,
                    category,
                    unit_id,
                    unit_code_str,
                    unit_code_str, // unit_label same as code for imports
                    units_per_pack,
                    retail_price_paise,
                    cost_price_paise,
                    promo_price_paise,
                    label_line1,
                    label_line2,
                    location_id,
                    None::<i64>, // sub_location_id
                    None::<i64>, // position
                    min_qty,
                    barcode_format,
                    now_ms,
                ],
            ) {
                Ok(_) => result.created += 1,
                Err(e) => {
                    result.errors.push(ImportRowError {
                        row: row_num,
                        message: format!("DB error: {}", e),
                    });
                    result.skipped += 1;
                }
            }
        }
        Ok::<(), AppError>(())
    })?;

    Ok(result)
}

/// Generate next SKU from the sequences table within a transaction.
fn auto_sku(tx: &rusqlite::Connection) -> String {
    let _ = tx.execute(
        "UPDATE sequences SET value = value + 1 WHERE name = 'sku'",
        [],
    );
    let n: i64 = tx
        .query_row("SELECT value FROM sequences WHERE name = 'sku'", [], |r| {
            r.get(0)
        })
        .unwrap_or(1);
    format!("SKU-{n:06}")
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
    let user = current_user()?;
    require_role(&user, &[Role::Owner, Role::Stocker])?;

    let (headers, rows) = parse_csv(&csv_text);
    if headers.is_empty() {
        return Err(AppError::Validation("CSV has no headers".into()));
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
            "SELECT id, name, sku_code, barcode, unit_id, unit_code, units_per_pack, cost_paise, retail_price_paise FROM items WHERE is_active = 1",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(ItemLookupRow {
                id: r.get(0)?,
                name: r.get(1)?,
                sku_code: r.get(2)?,
                barcode: r.get(3)?,
                unit_id: r.get(4)?,
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
                        message: format!("item '{}' not found", item_ref.unwrap()),
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
                                "INSERT INTO vendors (name, credit_limit_paise, is_active, created_at, updated_at) VALUES (?1, 0, 1, ?2, ?2)",
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
            let base = crate::commands::purchases::base_qty(qty, "unit", item.units_per_pack as f64);
            let line_total = (base * cost_paise as f64).round() as i64;

            // Create purchase
            let now_ms = chrono::Utc::now().timestamp_millis();
            let purchase_number = {
                let next_id: i64 = tx
                    .query_row("SELECT COALESCE(MAX(id), 0) + 1 FROM purchases", [], |r| r.get(0))
                    .unwrap_or(1);
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
                "INSERT INTO purchase_items (purchase_id, item_id, qty, unit_id, unit_price_paise, line_discount_paise, line_total_paise, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7)",
                params![pid, item.id, base, item.unit_id, cost_paise, line_total, now_ms],
            ) {
                result.errors.push(ImportRowError {
                    row: row_num,
                    message: format!("DB error creating line: {}", e),
                });
                // Don't skip — purchase row already created
                continue;
            }

            // Insert stock movement
            let _ = tx.execute(
                "INSERT INTO stock_movements (item_id, location_id, qty, kind_id, unit_id, ref_kind, ref_id, note, created_at, created_by)
                 VALUES (?1, ?2, ?3, (SELECT id FROM stock_movement_kinds WHERE code='purchase'), ?4, 'purchase', ?5, ?6, ?7, ?8)",
                params![item.id, location_id, base, item.unit_id, pid, notes, now_ms, user.id],
            );

            result.created += 1;
        }
        Ok::<(), AppError>(())
    })?;

    Ok(result)
}

struct ItemLookupRow {
    id: i64,
    name: String,
    sku_code: String,
    barcode: Option<String>,
    unit_id: i64,
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

fn date_to_ms(date: &str) -> i64 {
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map(|d| {
            d.and_time(chrono::NaiveTime::MIN)
                .and_utc()
                .timestamp_millis()
        })
        .unwrap_or_else(|_| chrono::Utc::now().timestamp_millis())
}

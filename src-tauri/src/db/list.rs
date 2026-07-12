//! Paginated query helpers for the unified list display system (PR-1).
//!
//! Provides `ListQuery` (deserialized from the Tauri IPC payload), `ListPage<T>`
//! (the standard response envelope), and `paged_query` (builds a filtered,
//! sorted, paginated SELECT + COUNT pair from caller-supplied SQL fragments).

use std::collections::HashMap;

use rusqlite::{params_from_iter, Connection, ToSql};
use serde::{Deserialize, Serialize};

/// Deserialized from the frontend's list query payload.
///
/// `filters` is a freeform map — each endpoint interprets its own keys
/// (e.g. `brand_id`, `status`, `date_from`).  Keys not recognised by an
/// endpoint are silently ignored.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ListQuery {
    pub search: Option<String>,
    pub sort_field: Option<String>,
    pub sort_dir: Option<String>, // "asc" | "desc" | null
    #[serde(default)]
    pub filters: HashMap<String, serde_json::Value>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// Standard response envelope for every paginated list command.
#[derive(Debug, Clone, Serialize)]
pub struct ListPage<T: Serialize> {
    pub rows: Vec<T>,
    pub total: i64,
}

/// Sanitize `sort_field` against a caller-supplied whitelist.
///
/// Returns the field name if it appears in `whitelist`; otherwise returns
/// `default`.  The caller should pass the SQL column name (e.g. `"name"`,
/// `"created_at"`).
pub fn sanitize_sort(sort_field: Option<&str>, whitelist: &[&str], default: &str) -> String {
    match sort_field {
        Some(f) if whitelist.iter().any(|w| *w == f) => f.to_string(),
        _ => default.to_string(),
    }
}

/// Resolve a user-supplied sort direction to `"ASC"` or `"DESC"`.
///
/// Defaults to `"DESC"` for anything that is not literally `"asc"`
/// (case-insensitive).
pub fn sanitize_dir(sort_dir: Option<&str>) -> &'static str {
    match sort_dir.map(|s| s.to_ascii_lowercase()) {
        Some(ref s) if s == "asc" => "ASC",
        _ => "DESC",
    }
}

/// Run a paginated SELECT with an accompanying COUNT(*).
///
/// `rusqlite::Connection` is single-threaded, so the two queries are executed
/// sequentially.  The helper exists to centralise the SQL assembly (WHERE
/// clause stitching, LIMIT/OFFSET binding) so each endpoint stays small.
///
/// # Parameters
///
/// * `conn`           — an open rusqlite `Connection` (already locked by the caller).
/// * `base_select`    — e.g. `"SELECT cols FROM table WHERE 1=1"`.
/// * `count_select`   — e.g. `"SELECT COUNT(*) FROM table WHERE 1=1"`.
/// * `where_clauses`  — extra `AND …` fragments appended to both queries.
/// * `order_by_clause` — includes ORDER BY + LIMIT + OFFSET, e.g.
///   `" ORDER BY name COLLATE NOCASE ASC LIMIT ? OFFSET ?"`.
///   Appended verbatim to `base_select` after the WHERE suffix.
/// * `params`         — bound parameters matching the order they appear in
///   `where_clauses` **and** `order_by_clause`.
/// * `row_mapper`     — closure converting a `&rusqlite::Row` to `T`.
///
/// Returns `(rows, total)`.
pub fn paged_query<T, F>(
    conn: &Connection,
    base_select: &str,
    count_select: &str,
    where_clauses: &[&str],
    order_by_clause: &str,
    params: &[Box<dyn ToSql>],
    mut row_mapper: F,
) -> rusqlite::Result<(Vec<T>, i64)>
where
    F: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
{
    // Build the WHERE suffix shared by both queries.
    let where_suffix = if where_clauses.is_empty() {
        String::new()
    } else {
        let mut clauses = where_clauses.iter();
        match clauses.next() {
            Some(first) => {
                let mut s = format!(" WHERE {}", first);
                for clause in clauses {
                    s.push_str(&format!(" AND {}", clause));
                }
                s
            }
            None => String::new(),
        }
    };

    let rows_sql = format!("{}{}{}", base_select, where_suffix, order_by_clause);
    let count_sql = format!("{}{}", count_select, where_suffix);

    // Rows query (LIMIT/OFFSET applied).
    let mut stmt = conn.prepare(&rows_sql)?;
    let rows_iter = stmt.query_map(params_from_iter(params.iter().map(|b| b.as_ref())), &mut row_mapper)?;
    let rows: rusqlite::Result<Vec<T>> = rows_iter.collect();
    let rows = rows?;

    // Count query (no LIMIT/OFFSET — skip last 2 params).
    let count_params = if params.len() >= 2 {
        &params[..params.len() - 2]
    } else {
        params
    };
    let total: i64 = conn.query_row(
        &count_sql,
        params_from_iter(count_params.iter().map(|b| b.as_ref())),
        |r| r.get(0),
    )?;

    Ok((rows, total))
}

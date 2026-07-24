//! Paged lists, period summaries, payment stubs.
use chrono::NaiveDate;
use serde::Serialize;
use crate::commands::auth::AppState;
use crate::db::list::{paged_query, sanitize_dir, sanitize_sort, ListPage, ListQuery};
use crate::error::{AppError, AppResult};
use crate::security::ipc_auth;
use super::helpers::*;
use super::return_sale::{row_to_sale_return, SaleReturn, SaleReturnHeader};

const SALES_SORT_WHITELIST: &[&str] =
    &["date", "no", "total", "subtotal", "paid_amount", "customer_name", "created_at"];

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_list_sales_paged(
    state: tauri::State<'_, AppState>,
    query: ListQuery,
) -> AppResult<ListPage<Sale>> {
    ipc_auth::authorize_err("cmd_list_sales_paged", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let limit = query.limit.unwrap_or(25).clamp(1, 100);
    let offset = query.offset.unwrap_or(0).max(0);
    let sort_field =
        sanitize_sort(query.sort_field.as_deref(), SALES_SORT_WHITELIST, "date");
    let sort_dir = sanitize_dir(query.sort_dir.as_deref());

    db.with_raw(|c| {
        let mut wheres: Vec<String> = Vec::new();
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        if let Some(s) = query.filters.get("status").and_then(|v| v.as_str()) {
            wheres.push("s.status = ?".to_string());
            params.push(Box::new(s.to_string()));
        }
        if let Some(cid) = query.filters.get("customer_id").and_then(|v| v.as_i64()) {
            wheres.push("s.customer_id = ?".to_string());
            params.push(Box::new(cid));
        }
        if let Some(d) = query.filters.get("from_date").and_then(|v| v.as_str()) {
            if !d.is_empty() {
                wheres.push("s.date >= ?".to_string());
                params.push(Box::new(d.to_string()));
            }
        }
        if let Some(d) = query.filters.get("to_date").and_then(|v| v.as_str()) {
            if !d.is_empty() {
                let upper = NaiveDate::parse_from_str(d, "%Y-%m-%d")
                    .ok()
                    .and_then(|nd| nd.succ_opt())
                    .map(|nd| nd.format("%Y-%m-%d").to_string())
                    .unwrap_or_else(|| d.to_string());
                wheres.push("s.date < ?".to_string());
                params.push(Box::new(upper));
            }
        }

        let sort_col = match sort_field.as_str() {
            "customer_name" => "COALESCE(c.name, '')".to_string(),
            other => format!("s.{}", other),
        };
        let where_refs: Vec<&str> = wheres.iter().map(|s| s.as_str()).collect();
        let order_by = format!(" ORDER BY {} {} LIMIT ? OFFSET ?", sort_col, sort_dir);
        params.push(Box::new(limit));
        params.push(Box::new(offset));

        let base_select =
            "SELECT s.id, s.no, s.customer_id, s.date, s.status, s.subtotal, s.bill_discount, \
                    s.total, s.paid_amount, s.payment_modes_json, s.validity_days, \
                    s.converted_from_id, s.user_id, s.created_at, \
                    COALESCE(c.name, '') \
             FROM sales s \
             LEFT JOIN customers c ON c.id = s.customer_id";
        let count_select = "SELECT COUNT(*) FROM sales s";

        let (rows, total) = paged_query(
            c,
            base_select,
            count_select,
            &where_refs,
            &order_by,
            &params,
            row_to_sale_header_with_name,
        )?;

        Ok(ListPage {
            rows,
            total,
        })
    })
}

const SALE_RETURNS_SORT_WHITELIST: &[&str] =
    &["id", "no", "refund_total", "date", "created_at"];

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_list_sale_returns_paged(
    state: tauri::State<'_, AppState>,
    query: ListQuery,
) -> AppResult<ListPage<SaleReturn>> {
    ipc_auth::authorize_err("cmd_list_sale_returns_paged", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let limit = query.limit.unwrap_or(25).clamp(1, 100);
    let offset = query.offset.unwrap_or(0).max(0);
    let sort_field =
        sanitize_sort(query.sort_field.as_deref(), SALE_RETURNS_SORT_WHITELIST, "id");
    let sort_dir = sanitize_dir(query.sort_dir.as_deref());

    let sort_col = match sort_field.as_str() {
        "no" => "sr.no",
        "refund_total" => "sr.refund_total_paise",
        "date" => "COALESCE(sr.date, sr.created_at)",
        "created_at" => "sr.created_at",
        "id" | _ => "sr.id",
    };

    db.with_raw(|c| {
        let mut wheres: Vec<String> = Vec::new();
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        if let Some(cid) = query.filters.get("customer_id").and_then(|v| v.as_i64()) {
            wheres.push("s.customer_id = ?".to_string());
            params.push(Box::new(cid));
        }
        if let Some(d) = query.filters.get("from_date").and_then(|v| v.as_str()) {
            if !d.is_empty() {
                wheres.push("sr.created_at >= ?".to_string());
                params.push(Box::new(date_to_ms(d)));
            }
        }
        if let Some(d) = query.filters.get("to_date").and_then(|v| v.as_str()) {
            if !d.is_empty() {
                wheres.push("sr.created_at < ?".to_string());
                params.push(Box::new(date_to_ms(d) + 86_400_000));
            }
        }

        let where_refs: Vec<&str> = wheres.iter().map(|s| s.as_str()).collect();
        let order_by = format!(" ORDER BY {} {} LIMIT ? OFFSET ?", sort_col, sort_dir);
        params.push(Box::new(limit));
        params.push(Box::new(offset));

        let base_select =
            "SELECT sr.id, COALESCE(sr.no, ''), sr.sale_id, \
                    COALESCE(sr.date, CAST(sr.created_at AS TEXT)) AS date, sr.reason, \
                    sr.refund_total_paise, \
                    CAST(sr.created_at AS TEXT) AS created_at, sr.created_by \
             FROM sale_returns sr \
             JOIN sales s ON s.id = sr.sale_id";
        let count_select =
            "SELECT COUNT(*) FROM sale_returns sr \
             JOIN sales s ON s.id = sr.sale_id";

        let (headers, total) = paged_query(
            c,
            base_select,
            count_select,
            &where_refs,
            &order_by,
            &params,
            |r| {
                Ok(SaleReturnHeader {
                    id: r.get(0)?,
                    no: r.get(1)?,
                    sale_id: r.get(2)?,
                    date: r.get(3)?,
                    reason: r.get(4)?,
                    refund_total: r.get(5)?,
                    created_at: r.get(6)?,
                    created_by: r.get(7)?,
                })
            },
        )?;

        let mut out = Vec::with_capacity(headers.len());
        for h in headers {
            out.push(row_to_sale_return(c, &h)?);
        }
        Ok(ListPage { rows: out, total })
    })
}

#[derive(Debug, Serialize)]
pub struct SalesPeriodSummary {
    pub count: i64,
    pub total_paise: i64,
    pub avg_paise: i64,
    pub paid_paise: i64,
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_sales_period_summary(
    state: tauri::State<'_, AppState>,
    from_date: Option<String>,
    to_date: Option<String>,
    status: Option<String>,
) -> AppResult<SalesPeriodSummary> {
    ipc_auth::authorize_err("cmd_sales_period_summary", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let status_filter = status.as_deref().unwrap_or("final");
    db.with_raw(|c| {
        let mut wheres: Vec<String> = vec!["status = ?".to_string()];
        let mut params: Vec<Box<dyn rusqlite::ToSql>> =
            vec![Box::new(status_filter.to_string())];
        if let Some(d) = from_date.as_deref() {
            if !d.is_empty() {
                wheres.push("date >= ?".to_string());
                params.push(Box::new(d.to_string()));
            }
        }
        if let Some(d) = to_date.as_deref() {
            if !d.is_empty() {
                wheres.push("date <= ?".to_string());
                params.push(Box::new(d.to_string()));
            }
        }
        let where_suffix = format!(" WHERE {}", wheres.join(" AND "));
        let sql = format!(
            "SELECT COUNT(*), COALESCE(SUM(total), 0), CAST(COALESCE(AVG(total), 0) AS INTEGER), \
                    COALESCE(SUM(paid_amount), 0) FROM sales{}",
            where_suffix
        );
        let arg_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
        let (count, total, avg, paid): (i64, i64, i64, i64) =
            c.query_row(&sql, arg_refs.as_slice(), |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?;
        Ok(SalesPeriodSummary {
            count,
            total_paise: total,
            avg_paise: avg,
            paid_paise: paid,
        })
    })
}

#[derive(Debug, Serialize)]
pub struct SaleReturnsPeriodSummary {
    pub count: i64,
    pub total_refund_paise: i64,
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_sale_returns_period_summary(
    state: tauri::State<'_, AppState>,
    from_date: Option<String>,
    to_date: Option<String>,
) -> AppResult<SaleReturnsPeriodSummary> {
    ipc_auth::authorize_err("cmd_sale_returns_period_summary", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    db.with_raw(|c| {
        let mut wheres: Vec<String> = Vec::new();
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(d) = from_date.as_deref() {
            if !d.is_empty() {
                wheres.push("created_at >= ?".to_string());
                params.push(Box::new(date_to_ms(d)));
            }
        }
        if let Some(d) = to_date.as_deref() {
            if !d.is_empty() {
                wheres.push("created_at < ?".to_string());
                params.push(Box::new(date_to_ms(d) + 86_400_000));
            }
        }
        let where_suffix = if wheres.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", wheres.join(" AND "))
        };
        let sql = format!(
            "SELECT COUNT(*), COALESCE(SUM(refund_total_paise), 0) FROM sale_returns{}",
            where_suffix
        );
        let arg_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
        let (count, total_refund): (i64, i64) =
            c.query_row(&sql, arg_refs.as_slice(), |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?;
        Ok(SaleReturnsPeriodSummary {
            count,
            total_refund_paise: total_refund,
        })
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_list_sale_payments(
    state: tauri::State<'_, AppState>,
    _sale_id: i64,
) -> AppResult<Vec<serde_json::Value>> {
    ipc_auth::authorize_err("cmd_list_sale_payments", state.inner())?;
    Ok(Vec::new())
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_record_sale_payment(
    state: tauri::State<'_, AppState>,
    _sale_id: i64,
    _amount: i64,
    _mode: String,
    _date: Option<String>,
) -> AppResult<i64> {
    ipc_auth::authorize_err("cmd_record_sale_payment", state.inner())?;
    Err(AppError::Internal("not implemented".into()))
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_void_sale(
    state: tauri::State<'_, AppState>,
    _sale_id: i64,
    _pin: String,
) -> AppResult<()> {
    ipc_auth::authorize_err("cmd_void_sale", state.inner())?;
    Err(AppError::Internal("not implemented".into()))
}


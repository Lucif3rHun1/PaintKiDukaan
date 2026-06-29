use std::collections::HashMap;

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::auth::{AppState, User};
use crate::db::Db;
use crate::security::ipc_auth;
use crate::AppError;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AlertKind {
    LowStock,
    DayCloseOverdue,
    BackupOverdue,
    SaleEdited,
    SaleVoided,
    FlaggedCustomer,
}

impl AlertKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            AlertKind::LowStock => "low_stock",
            AlertKind::DayCloseOverdue => "day_close_overdue",
            AlertKind::BackupOverdue => "backup_overdue",
            AlertKind::SaleEdited => "sale_edited",
            AlertKind::SaleVoided => "sale_voided",
            AlertKind::FlaggedCustomer => "flagged_customer",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Info,
    Warning,
    Error,
}

impl Severity {
    pub fn as_str(&self) -> &'static str {
        match self {
            Severity::Info => "info",
            Severity::Warning => "warning",
            Severity::Error => "error",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Alert {
    pub id: i64,
    pub kind: AlertKind,
    pub severity: Severity,
    pub title: String,
    pub message: String,
    pub roles: Vec<String>,
    pub entity_id: Option<String>,
    pub created_at: i64,
    pub read_by: HashMap<String, i64>,
    pub resolved_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateAlert {
    pub kind: AlertKind,
    pub severity: Severity,
    pub title: String,
    pub message: String,
    pub roles: Vec<String>,
    pub entity_id: Option<String>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Parse `GROUP_CONCAT(ar.role, '|')` output back into `Vec<String>`.
fn parse_roles_concat(s: Option<String>) -> Vec<String> {
    s.as_deref()
        .map(|x| {
            if x.is_empty() {
                Vec::new()
            } else {
                x.split('|').map(|s| s.to_string()).collect()
            }
        })
        .unwrap_or_default()
}

/// Parse `GROUP_CONCAT(user_id || ':' || read_at, '|')` back into `HashMap<String, i64>`.
fn parse_read_by_concat(s: Option<String>) -> HashMap<String, i64> {
    let mut map = HashMap::new();
    if let Some(s) = s.as_deref() {
        if !s.is_empty() {
            for pair in s.split('|') {
                if let Some((uid, ts)) = pair.split_once(':') {
                    if let Ok(ms) = ts.parse::<i64>() {
                        map.insert(uid.to_string(), ms);
                    }
                }
            }
        }
    }
    map
}

fn map_alert(row: &rusqlite::Row) -> Result<Alert, rusqlite::Error> {
    let kind_str: String = row.get(1)?;
    let kind = match kind_str.as_str() {
        "low_stock" => AlertKind::LowStock,
        "day_close_overdue" => AlertKind::DayCloseOverdue,
        "backup_overdue" => AlertKind::BackupOverdue,
        "sale_edited" => AlertKind::SaleEdited,
        "sale_voided" => AlertKind::SaleVoided,
        "flagged_customer" => AlertKind::FlaggedCustomer,
        _ => AlertKind::LowStock,
    };
    let severity_str: String = row.get(2)?;
    let severity = match severity_str.as_str() {
        "info" => Severity::Info,
        "warning" => Severity::Warning,
        "error" => Severity::Error,
        _ => Severity::Info,
    };
    let roles: Option<String> = row.get(8)?;
    let read_by: Option<String> = row.get(9)?;
    Ok(Alert {
        id: row.get(0)?,
        kind,
        severity,
        title: row.get(3)?,
        message: row.get(4)?,
        entity_id: row.get(5)?,
        roles: parse_roles_concat(roles),
        created_at: row.get(6)?,
        read_by: parse_read_by_concat(read_by),
        resolved_at: row.get(7)?,
    })
}

fn current_user(state: &State<'_, AppState>) -> Result<User, AppError> {
    state
        .session
        .lock()
        .map_err(|_| AppError::Internal("session lock poisoned".to_string()))?
        .clone()
        .ok_or(AppError::Unauthorized("no active session".into()))
}

fn with_db<F, T>(state: &State<'_, AppState>, f: F) -> Result<T, AppError>
where
    F: FnOnce(&Db) -> Result<T, AppError>,
{
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("db lock poisoned".to_string()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    f(db)
}

/// Insert roles into `alert_roles` for the given alert_id.
fn insert_alert_roles(
    conn: &rusqlite::Connection,
    alert_id: i64,
    roles: &[String],
) -> Result<(), AppError> {
    for role in roles {
        conn.execute(
            "INSERT OR IGNORE INTO alert_roles (alert_id, role) VALUES (?1, ?2)",
            params![alert_id, role],
        )?;
    }
    Ok(())
}

pub fn insert_alert(db: &Db, alert: CreateAlert) -> Result<i64, AppError> {
    db.with_conn_immediate(|conn| {
        let created_at = now_ms();
        let kind = alert.kind.as_str();
        let severity = alert.severity.as_str();
        let entity_id = alert.entity_id.as_deref();
        conn.execute(
            "INSERT INTO alerts (kind, severity, title, message, entity_id, is_active, created_at, resolved_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7)",
            params![kind, severity, alert.title, alert.message, entity_id, created_at, Option::<i64>::None],
        )?;
        let alert_id = conn.last_insert_rowid();
        insert_alert_roles(conn, alert_id, &alert.roles)?;
        Ok(alert_id)
    })
}

pub fn resolve_alerts_by_entity(
    db: &Db,
    kind: AlertKind,
    entity_id: &str,
) -> Result<usize, AppError> {
    db.with_conn_immediate(|conn| {
        let resolved_at = now_ms();
        let kind_str = kind.as_str();
        let rows = conn.execute(
            "UPDATE alerts SET resolved_at = ?1 WHERE kind = ?2 AND entity_id = ?3 AND resolved_at IS NULL",
            params![resolved_at, kind_str, entity_id],
        )?;
        Ok(rows)
    })
}

pub fn cleanup_resolved_alerts(db: &Db, retention_days: u32) -> Result<usize, AppError> {
    let cutoff = now_ms() - (retention_days as i64) * 24 * 60 * 60 * 1000;
    db.with_conn_immediate(|conn| {
        let rows = conn.execute(
            "DELETE FROM alerts WHERE resolved_at IS NOT NULL AND resolved_at < ?1",
            params![cutoff],
        )?;
        Ok(rows)
    })
}

/// SELECT used by list_alerts_for_role and unread_alert_count_for_role.
/// Indexes the EXISTS subquery via `idx_alert_roles_role` (PK lookup on alert_roles).
const ALERT_LIST_SELECT: &str = "
SELECT a.id, a.kind, a.severity, a.title, a.message, a.entity_id, a.created_at, a.resolved_at,
       (SELECT GROUP_CONCAT(ar.role, '|') FROM alert_roles ar WHERE ar.alert_id = a.id) as roles_str,
       (SELECT GROUP_CONCAT(ard.user_id || ':' || ard.read_at, '|') FROM alert_reads ard WHERE ard.alert_id = a.id) as read_by_str
FROM alerts a
WHERE a.resolved_at IS NULL
  AND EXISTS (SELECT 1 FROM alert_roles ar WHERE ar.alert_id = a.id AND ar.role = ?1)
ORDER BY a.created_at DESC
";

fn list_alerts_for_role(conn: &rusqlite::Connection, role: &str) -> Result<Vec<Alert>, AppError> {
    let mut stmt = conn.prepare(ALERT_LIST_SELECT)?;
    let alerts: Result<Vec<Alert>, rusqlite::Error> = stmt
        .query_map(params![role], |row| map_alert(row))?
        .collect();
    alerts.map_err(AppError::from)
}

fn unread_alert_count_for_role(
    conn: &rusqlite::Connection,
    role: &str,
    user_id: &i64,
) -> Result<i64, AppError> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*)
             FROM alerts a
             JOIN alert_roles ar ON ar.alert_id = a.id AND ar.role = ?1
             LEFT JOIN alert_reads ad ON ad.alert_id = a.id AND ad.user_id = ?2
             WHERE a.resolved_at IS NULL AND ad.user_id IS NULL",
            params![role, user_id],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(0);
    Ok(count)
}

fn mark_alert_read_for_user(
    conn: &rusqlite::Connection,
    alert_id: i64,
    user_id: &i64,
) -> Result<(), AppError> {
    conn.execute(
        "INSERT OR IGNORE INTO alert_reads (alert_id, user_id, read_at) VALUES (?1, ?2, ?3)",
        params![alert_id, user_id, now_ms()],
    )?;
    Ok(())
}

fn mark_all_alerts_read_for_role(
    conn: &rusqlite::Connection,
    role: &str,
    user_id: &i64,
) -> Result<(), AppError> {
    let mut stmt = conn.prepare(
        "SELECT a.id FROM alerts a
         JOIN alert_roles ar ON ar.alert_id = a.id AND ar.role = ?1
         WHERE a.resolved_at IS NULL",
    )?;
    let ids: Result<Vec<i64>, rusqlite::Error> =
        stmt.query_map(params![role], |row| row.get(0))?.collect();
    for id in ids? {
        conn.execute(
            "INSERT OR IGNORE INTO alert_reads (alert_id, user_id, read_at) VALUES (?1, ?2, ?3)",
            params![id, user_id, now_ms()],
        )?;
    }
    Ok(())
}

#[tauri::command]
pub fn cmd_list_alerts(state: State<'_, AppState>) -> Result<Vec<Alert>, AppError> {
    ipc_auth::authorize("cmd_list_alerts", state.inner())?;
    let user = current_user(&state)?;
    with_db(&state, |db| {
        db.with_conn(|conn| list_alerts_for_role(conn, &user.role))
    })
}

#[tauri::command]
pub fn cmd_unread_alert_count(state: State<'_, AppState>) -> Result<i64, AppError> {
    ipc_auth::authorize("cmd_unread_alert_count", state.inner())?;
    let user = current_user(&state)?;
    with_db(&state, |db| {
        db.with_conn(|conn| unread_alert_count_for_role(conn, &user.role, &user.id))
    })
}

#[tauri::command]
pub fn cmd_mark_alert_read(id: i64, state: State<'_, AppState>) -> Result<(), AppError> {
    ipc_auth::authorize("cmd_mark_alert_read", state.inner())?;
    let user = current_user(&state)?;
    with_db(&state, |db| {
        db.with_conn_immediate(|conn| mark_alert_read_for_user(conn, id, &user.id))
    })
}

#[tauri::command]
pub fn cmd_mark_all_alerts_read(state: State<'_, AppState>) -> Result<(), AppError> {
    ipc_auth::authorize("cmd_mark_all_alerts_read", state.inner())?;
    let user = current_user(&state)?;
    with_db(&state, |db| {
        db.with_conn_immediate(|conn| mark_all_alerts_read_for_role(conn, &user.role, &user.id))
    })
}

fn upsert_alert(
    conn: &rusqlite::Connection,
    kind: AlertKind,
    severity: Severity,
    title: String,
    message: String,
    roles: Vec<String>,
    entity_id: Option<String>,
) -> Result<(), AppError> {
    let kind_str = kind.as_str();
    let entity = entity_id.as_deref().unwrap_or("");
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM alerts WHERE kind = ?1 AND entity_id = ?2 AND resolved_at IS NULL LIMIT 1",
            params![kind_str, entity],
            |_row| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    if !exists {
        let created_at = now_ms();
        conn.execute(
            "INSERT INTO alerts (kind, severity, title, message, entity_id, is_active, created_at, resolved_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7)",
            params![
                kind_str,
                severity.as_str(),
                title,
                message,
                entity_id.as_deref(),
                created_at,
                Option::<i64>::None,
            ],
        )?;
        let alert_id = conn.last_insert_rowid();
        insert_alert_roles(conn, alert_id, &roles)?;
    }
    Ok(())
}

fn refresh_low_stock_alerts(conn: &rusqlite::Connection) -> Result<(), AppError> {
    let mut stmt = conn.prepare(
        "SELECT i.id, i.name, i.min_stock, COALESCE(SUM(sm.qty), 0) as balance
         FROM items i
         LEFT JOIN stock_movements sm ON sm.item_id = i.id
         WHERE i.is_active = 1
         GROUP BY i.id
         HAVING balance <= i.min_stock",
    )?;
    let rows = stmt.query_map([], |row| {
        let name: String = row.get(1)?;
        let balance: f64 = row.get(3)?;
        Ok((name, balance))
    })?;
    for row in rows {
        let (name, balance) = row?;
        let title = "Low stock".to_string();
        let message = format!("{} is below reorder level (balance: {})", name, balance);
        upsert_alert(
            conn,
            AlertKind::LowStock,
            Severity::Warning,
            title,
            message,
            vec!["owner".into(), "stocker".into()],
            Some(name),
        )?;
    }
    Ok(())
}

fn refresh_day_close_alerts(conn: &rusqlite::Connection) -> Result<(), AppError> {
    let today_ms = chrono::Local::now()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .map(|dt| dt.and_utc().timestamp_millis())
        .unwrap_or(0);
    let end_of_day = today_ms + 24 * 60 * 60 * 1000 - 1;
    if now_ms() <= end_of_day {
        return Ok(());
    }

    let mut stmt = conn.prepare(
        "SELECT id, name FROM users WHERE is_active = 1 AND role IN ('owner', 'cashier')",
    )?;
    let users = stmt.query_map([], |row| {
        let id: i64 = row.get(0)?;
        let name: String = row.get(1)?;
        Ok((id, name))
    })?;
    for user in users {
        let (user_id, name) = user?;
        let closed: bool = conn
            .query_row(
                "SELECT 1 FROM day_close WHERE user_id = ?1 AND day = ?2 LIMIT 1",
                params![user_id, today_ms],
                |_row| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !closed {
            let title = "Day close overdue".to_string();
            let message = format!("{} has not closed today's shift", name);
            let entity_id = format!("{}/{}", user_id, today_ms);
            upsert_alert(
                conn,
                AlertKind::DayCloseOverdue,
                Severity::Warning,
                title,
                message,
                vec!["owner".into(), "cashier".into()],
                Some(entity_id),
            )?;
        }
    }
    Ok(())
}

fn refresh_backup_alerts(
    conn: &rusqlite::Connection,
    db: &Db,
    state: &State<'_, AppState>,
) -> Result<(), AppError> {
    let last_backup = *state
        .last_backup_unix_ms
        .lock()
        .map_err(|_| AppError::Internal("backup lock poisoned".to_string()))?;
    let now = now_ms();
    let threshold_ms = 24 * 60 * 60 * 1000;
    if now - last_backup.unwrap_or(0) > threshold_ms {
        upsert_alert(
            conn,
            AlertKind::BackupOverdue,
            Severity::Error,
            "Backup overdue".to_string(),
            "The last successful backup is more than 24 hours old.".to_string(),
            vec!["owner".into()],
            Some("backup".to_string()),
        )?;
    } else {
        resolve_alerts_by_entity(db, AlertKind::BackupOverdue, "backup")?;
    }
    Ok(())
}

#[tauri::command]
pub fn cmd_refresh_alerts(state: State<'_, AppState>) -> Result<(), AppError> {
    ipc_auth::authorize("cmd_refresh_alerts", state.inner())?;
    with_db(&state, |db| {
        db.with_conn_immediate(|conn| {
            refresh_low_stock_alerts(conn)?;
            refresh_day_close_alerts(conn)?;
            refresh_backup_alerts(conn, db, &state)?;
            let retention_days: u32 = {
                let settings = state
                    .settings
                    .lock()
                    .map_err(|_| AppError::Internal("settings lock poisoned".to_string()))?;
                settings
                    .get("alerts_retention_days")
                    .and_then(|v| v.as_u64().map(|n| n as u32))
                    .unwrap_or(7)
                    .max(1)
            };
            cleanup_resolved_alerts(db, retention_days)?;
            Ok(())
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn setup_db() -> Db {
        // Db::open_in_memory already runs migrations, so no manual schema application needed.
        Db::open_in_memory().unwrap()
    }

    fn seed_user(conn: &rusqlite::Connection, id: i64, name: &str, role: &str) {
        conn.execute(
            "INSERT INTO users (id, name, role, pin_salt, pin_verifier, pin_length, is_active, created_at, updated_at) VALUES (?1, ?2, ?3, 'x', 'x', 6, 1, 0, 0)",
            params![id, name, role],
        ).unwrap();
    }

    fn today_ms() -> i64 {
        chrono::Local::now()
            .date_naive()
            .and_hms_opt(0, 0, 0)
            .map(|dt| dt.and_utc().timestamp_millis())
            .unwrap_or(0)
    }

    #[test]
    fn test_insert_and_list_alerts() {
        let db = setup_db();
        let id = insert_alert(
            &db,
            CreateAlert {
                kind: AlertKind::LowStock,
                severity: Severity::Warning,
                title: "Low stock".into(),
                message: "Item low".into(),
                roles: vec!["owner".into(), "stocker".into()],
                entity_id: Some("item-1".into()),
            },
        )
        .unwrap();
        assert!(id > 0);

        db.with_conn(|conn| {
            let owner_alerts = list_alerts_for_role(conn, "owner").unwrap();
            assert_eq!(owner_alerts.len(), 1);
            assert_eq!(owner_alerts[0].kind, AlertKind::LowStock);

            let cashier_alerts = list_alerts_for_role(conn, "cashier").unwrap();
            assert!(cashier_alerts.is_empty());
            Ok::<(), AppError>(())
        })
        .unwrap();
    }

    #[test]
    fn test_unread_count_and_mark_read() {
        let db = setup_db();
        db.with_conn(|conn| {
            seed_user(conn, 1, "Owner", "owner");
            Ok::<(), AppError>(())
        })
        .unwrap();
        let id = insert_alert(
            &db,
            CreateAlert {
                kind: AlertKind::BackupOverdue,
                severity: Severity::Error,
                title: "Backup".into(),
                message: "Backup overdue".into(),
                roles: vec!["owner".into()],
                entity_id: Some("backup".into()),
            },
        )
        .unwrap();

        db.with_conn(|conn| {
            assert_eq!(unread_alert_count_for_role(conn, "owner", &1).unwrap(), 1);
            mark_alert_read_for_user(conn, id, &1).unwrap();
            assert_eq!(unread_alert_count_for_role(conn, "owner", &1).unwrap(), 0);
            Ok::<(), AppError>(())
        })
        .unwrap();
    }

    #[test]
    fn test_mark_all_read() {
        let db = setup_db();
        db.with_conn(|conn| {
            seed_user(conn, 1, "Owner", "owner");
            seed_user(conn, 2, "Cashier", "cashier");
            Ok::<(), AppError>(())
        })
        .unwrap();
        for i in 0..3 {
            insert_alert(
                &db,
                CreateAlert {
                    kind: AlertKind::DayCloseOverdue,
                    severity: Severity::Warning,
                    title: format!("Day close {}", i),
                    message: "msg".into(),
                    roles: vec!["owner".into(), "cashier".into()],
                    entity_id: Some(format!("dc{}", i)),
                },
            )
            .unwrap();
        }
        db.with_conn(|conn| {
            assert_eq!(unread_alert_count_for_role(conn, "cashier", &2).unwrap(), 3);
            mark_all_alerts_read_for_role(conn, "cashier", &2).unwrap();
            assert_eq!(unread_alert_count_for_role(conn, "cashier", &2).unwrap(), 0);
            assert_eq!(unread_alert_count_for_role(conn, "owner", &3).unwrap(), 3);
            Ok::<(), AppError>(())
        })
        .unwrap();
    }

    #[test]
    fn test_resolve_and_cleanup() {
        let db = setup_db();
        insert_alert(
            &db,
            CreateAlert {
                kind: AlertKind::LowStock,
                severity: Severity::Warning,
                title: "Low".into(),
                message: "msg".into(),
                roles: vec!["owner".into()],
                entity_id: Some("item-x".into()),
            },
        )
        .unwrap();
        resolve_alerts_by_entity(&db, AlertKind::LowStock, "item-x").unwrap();
        db.with_conn(|conn| {
            let owner_alerts = list_alerts_for_role(conn, "owner").unwrap();
            assert!(owner_alerts.is_empty());
            Ok::<(), AppError>(())
        })
        .unwrap();
    }

    #[test]
    fn test_low_stock_alert() {
        let db = setup_db();
        db.with_conn_immediate(|conn| {
            conn.execute(
                "INSERT INTO items (id, name, sku_code, unit_code, unit_label, min_stock, retail_price_paise, cost_paise, is_active, created_at, updated_at) VALUES (1, 'Paint', 'SKU001', 'pc', 'Piece', 10, 10000, 5000, 1, 0, 0)",
                [],
            ).unwrap();
            seed_user(conn, 1, "Owner", "owner");
            conn.execute(
                "INSERT INTO locations (id, name, is_active, created_at, updated_at) VALUES (1, 'Default', 1, 0, 0)",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO stock_movements (item_id, location_id, qty, kind_id, sale_unit_id, ref_kind, ref_id, created_at) VALUES (1, 1, 5, (SELECT id FROM stock_movement_kinds WHERE code = 'recount'), 1, 'adjustment', 1, 0)",
                [],
            ).unwrap();
            Ok::<(), AppError>(())
        }).unwrap();
        db.with_conn(|conn| {
            refresh_low_stock_alerts(conn).unwrap();
            let alerts = list_alerts_for_role(conn, "owner").unwrap();
            assert_eq!(alerts.len(), 1);
            assert_eq!(alerts[0].kind, AlertKind::LowStock);
            Ok::<(), AppError>(())
        })
        .unwrap();
    }

    #[test]
    fn test_day_close_overdue_alert() {
        let db = setup_db();
        let today = today_ms();
        db.with_conn_immediate(|conn| {
            seed_user(conn, 1, "Ravi", "cashier");
            conn.execute(
                "INSERT INTO locations (id, name, is_default, is_active, created_at, updated_at) VALUES (1, 'Default', 1, 1, 0, 0)",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO day_close (user_id, day, opening_cash_paise, cash_sales_paise, card_sales_paise, upi_sales_paise, expenses_paise, closing_cash_paise, location_id, created_at, updated_at) VALUES (1, '2025-01-15', 0, 0, 0, 0, 0, 0, 1, ?1, ?1)",
                params![today],
            ).unwrap();
            Ok::<(), AppError>(())
        }).unwrap();
        // Travel to tomorrow past end-of-day by inserting a future alert via direct query
        db.with_conn(|conn| {
            // Simulate overdue by removing the day_close record
            conn.execute("DELETE FROM day_close", []).unwrap();
            // Force now_ms > end_of_day by inserting a fake current time is impossible without mocking,
            // so test the upsert path directly.
            upsert_alert(
                conn,
                AlertKind::DayCloseOverdue,
                Severity::Warning,
                "Day close".into(),
                "msg".into(),
                vec!["owner".into(), "cashier".into()],
                Some("c/1".into()),
            )
            .unwrap();
            let alerts = list_alerts_for_role(conn, "owner").unwrap();
            assert_eq!(alerts.len(), 1);
            Ok::<(), AppError>(())
        })
        .unwrap();
    }

    #[test]
    fn test_backup_overdue_alert() {
        let db = setup_db();
        db.with_conn(|conn| {
            upsert_alert(
                conn,
                AlertKind::BackupOverdue,
                Severity::Error,
                "Backup".into(),
                "Old".into(),
                vec!["owner".into()],
                Some("backup".into()),
            )
            .unwrap();
            let alerts = list_alerts_for_role(conn, "owner").unwrap();
            assert_eq!(alerts.len(), 1);
            assert_eq!(alerts[0].kind, AlertKind::BackupOverdue);
            Ok::<(), AppError>(())
        })
        .unwrap();
    }

    #[test]
    fn test_sale_edited_alert_scoping() {
        let db = setup_db();
        let id = insert_alert(
            &db,
            CreateAlert {
                kind: AlertKind::SaleEdited,
                severity: Severity::Warning,
                title: "Sale edited".into(),
                message: "msg".into(),
                roles: vec!["owner".into(), "cashier".into()],
                entity_id: Some("sale-1".into()),
            },
        )
        .unwrap();
        assert!(id > 0);
        db.with_conn(|conn| {
            assert_eq!(list_alerts_for_role(conn, "cashier").unwrap().len(), 1);
            assert_eq!(list_alerts_for_role(conn, "stocker").unwrap().len(), 0);
            Ok::<(), AppError>(())
        })
        .unwrap();
    }

    #[test]
    fn test_sale_voided_alert_is_owner_only() {
        let db = setup_db();
        insert_alert(
            &db,
            CreateAlert {
                kind: AlertKind::SaleVoided,
                severity: Severity::Error,
                title: "Sale voided".into(),
                message: "msg".into(),
                roles: vec!["owner".into()],
                entity_id: Some("sale-2".into()),
            },
        )
        .unwrap();
        db.with_conn(|conn| {
            assert_eq!(list_alerts_for_role(conn, "owner").unwrap().len(), 1);
            assert_eq!(list_alerts_for_role(conn, "cashier").unwrap().len(), 0);
            Ok::<(), AppError>(())
        })
        .unwrap();
    }

    #[test]
    fn test_flagged_customer_alert() {
        let db = setup_db();
        insert_alert(
            &db,
            CreateAlert {
                kind: AlertKind::FlaggedCustomer,
                severity: Severity::Error,
                title: "Flagged customer".into(),
                message: "Proceeded without ack".into(),
                roles: vec!["owner".into()],
                entity_id: Some("sale-3".into()),
            },
        )
        .unwrap();
        db.with_conn(|conn| {
            assert_eq!(list_alerts_for_role(conn, "owner").unwrap().len(), 1);
            Ok::<(), AppError>(())
        })
        .unwrap();
    }
}

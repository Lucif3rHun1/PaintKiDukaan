//! Day-close commands (per-user end-of-day reconciliation).
//!
//! Per master plan §7.6. One row per (user_id, date). After a row is written
//! for a given date by cashier X, sales for that date are read-only to X
//! (owner override always allowed). The `expected_cash` formula is:
//!
//! ```text
//!     expected = opening_cash
//!              + cash_sales (auto-sum from sales.payment_modes_json)
//!              + cash_in
//!              - cash_out
//! ```
//!
//! `variance = counted_cash - expected_cash`.
//!
//! Backup gate (E48 / §7.6): when `settings.last_backup_at` is NULL or older
//! than 24h, the frontend must prompt the operator to "Back up & close | Skip
//! once | Cancel close". The backend enforces this by returning a
//! `BackupGate` decision the frontend renders; the actual save accepts
//! `backup_decision = 'back_up' | 'skip' | 'fresh'` and stamps
//! `backup_check_status` accordingly.

use rusqlite::params;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::commands::auth::AppState;

// -----------------------------------------------------------------------------
// Public types.
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct DayClose {
    pub id: i64,
    pub date: String,
    pub user_id: i64,
    pub opening_cash: i64,
    pub cash_sales: i64,
    pub cash_in: i64,
    pub cash_out: i64,
    pub counted_cash: i64,
    pub expected_cash: i64,
    pub variance: i64,
    pub notes: Option<String>,
    pub backup_check_status: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CashSalesSummary {
    pub date: String,
    pub user_id: i64,
    pub cash_sales_paise: i64,
    pub non_cash_sales_paise: i64,
    pub total_sales_paise: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupGate {
    pub needs_prompt: bool,
    pub age_hours: Option<f64>,
    pub reason: String,
    pub last_backup_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewDayClose {
    pub date: Option<String>,
    pub opening_cash: i64,
    pub cash_in: i64,
    pub cash_out: i64,
    pub counted_cash: i64,
    pub notes: Option<String>,
    pub backup_decision: String, // "back_up" | "skip" | "fresh"
}

// -----------------------------------------------------------------------------
// Errors.
// -----------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum DayCloseError {
    #[error("opening_cash must be >= 0")]
    BadOpening,
    #[error("cash_in/cash_out must be >= 0")]
    BadDelta,
    #[error("counted_cash must be >= 0")]
    BadCounted,
    #[error("invalid backup_decision: {0} (expected 'back_up' | 'skip' | 'fresh')")]
    BadBackupDecision(String),
    #[error("day close already exists for user on {date} — owner override required")]
    AlreadyClosed { date: String },
    #[error("db error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("{0}")]
    Other(#[from] anyhow::Error),
}

// -----------------------------------------------------------------------------
// Pure helpers.
// -----------------------------------------------------------------------------

pub fn expected_cash(opening: i64, cash_sales: i64, cash_in: i64, cash_out: i64) -> i64 {
    opening + cash_sales + cash_in - cash_out
}

pub fn variance(counted: i64, expected: i64) -> i64 {
    counted - expected
}

// -----------------------------------------------------------------------------
// Reads / gate / save.
// -----------------------------------------------------------------------------

/// Sum today's sales for a single user from `sales.payment_modes_json`.
/// We unpack the JSON array of `{mode, amount}` rows and filter for mode='cash'.
pub fn cash_sales_for(db: &Db, user_id: i64, date: &str) -> Result<CashSalesSummary, DayCloseError> {
    db.with_conn(|c| -> Result<CashSalesSummary, DayCloseError> {
        let mut stmt = c.prepare(
            "SELECT id, paid_amount, payment_modes_json
             FROM sales
             WHERE user_id = ?1 AND date = ?2 AND status = 'final'",
        )?;
        let rows = stmt.query_map(params![user_id, date], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        let mut cash: i64 = 0;
        let mut total: i64 = 0;
        for row in rows {
            let (_id, paid, json) = row?;
            total += paid;
            if let Ok(modes) = serde_json::from_str::<Vec<serde_json::Value>>(&json) {
                for m in modes {
                    if m.get("mode").and_then(|x| x.as_str()) == Some("cash") {
                        if let Some(amt) = m.get("amount").and_then(|x| x.as_i64()) {
                            cash += amt;
                        }
                    }
                }
            }
        }
        Ok(CashSalesSummary {
            date: date.into(),
            user_id,
            cash_sales_paise: cash,
            non_cash_sales_paise: total - cash,
            total_sales_paise: total,
        })
    })
}

/// Returns the previous closing opening_cash for this user (most recent
/// day_close before `date`). Defaults to 0.
pub fn last_opening_for(db: &Db, user_id: i64, date: &str) -> Result<i64, DayCloseError> {
    db.with_conn(|c| -> Result<i64, DayCloseError> {
        let v: Option<i64> = c
            .query_row(
                "SELECT counted_cash FROM day_close
                 WHERE user_id = ?1 AND date < ?2
                 ORDER BY date DESC LIMIT 1",
                params![user_id, date],
                |r| r.get(0),
            )
            .optional()?;
        Ok(v.unwrap_or(0))
    })
}

/// Check the backup gate (E48). Returns gate info so the UI can render the
/// "Back up & close | Skip once | Cancel close" prompt (E49).
pub fn backup_gate_check(db: &Db, now_epoch_secs: i64) -> Result<BackupGate, DayCloseError> {
    db.with_conn(|c| -> Result<BackupGate, DayCloseError> {
        let v: Option<Option<String>> = c
            .query_row(
                "SELECT last_backup_at FROM settings WHERE id = 1",
                [],
                |r| r.get(0),
            )
            .optional()?;
        let last = v.flatten();
        let age = match &last {
            Some(s) => parse_iso8601_to_epoch(s).map(|then| {
                let secs = now_epoch_secs - then;
                (secs as f64) / 3600.0
            }),
            None => None,
        };
        let needs_prompt = match &age {
            None => true,
            Some(h) if *h >= 24.0 => true,
            Some(_) => false,
        };
        let reason = match &age {
            None => "never".into(),
            Some(h) if *h >= 24.0 => format!("stale_{}h", h.round()),
            Some(h) => format!("fresh_{}h", h.round()),
        };
        Ok(BackupGate {
            needs_prompt,
            age_hours: age,
            reason,
            last_backup_at: last,
        })
    })
}

fn parse_iso8601_to_epoch(s: &str) -> Option<i64> {
    // Accept "YYYY-MM-DD HH:MM:SS" or RFC3339. We don't need second precision.
    chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
        .ok()
        .map(|ndt| ndt.and_utc().timestamp())
        .or_else(|| {
            chrono::DateTime::parse_from_rfc3339(s)
                .ok()
                .map(|dt| dt.timestamp())
        })
}

/// Lock state for a (user, date). After a cashier closes a day, that user's
/// sales for that date are read-only to that user. Owner override is allowed.
#[derive(Debug, Clone, Serialize)]
pub struct DayLockState {
    pub date: String,
    pub user_id: i64,
    pub is_locked: bool,
    pub day_close_id: Option<i64>,
}

pub fn lock_state(db: &Db, user_id: i64, date: &str) -> Result<DayLockState, DayCloseError> {
    db.with_conn(|c| -> Result<DayLockState, DayCloseError> {
        let row: Option<i64> = c
            .query_row(
                "SELECT id FROM day_close WHERE user_id = ?1 AND date = ?2",
                params![user_id, date],
                |r| r.get(0),
            )
            .optional()?;
        Ok(DayLockState {
            date: date.into(),
            user_id,
            is_locked: row.is_some(),
            day_close_id: row,
        })
    })
}

pub fn list(db: &Db, limit: i64) -> Result<Vec<DayClose>, DayCloseError> {
    db.with_conn(|c| -> Result<Vec<DayClose>, DayCloseError> {
        let limit = limit.clamp(1, 365);
        let mut stmt = c.prepare(
            "SELECT id, date, user_id, opening_cash, cash_sales, cash_in, cash_out,
                    counted_cash, expected_cash, variance, notes,
                    backup_check_status, created_at
             FROM day_close ORDER BY date DESC, id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], |r| {
            Ok(DayClose {
                id: r.get(0)?,
                date: r.get(1)?,
                user_id: r.get(2)?,
                opening_cash: r.get(3)?,
                cash_sales: r.get(4)?,
                cash_in: r.get(5)?,
                cash_out: r.get(6)?,
                counted_cash: r.get(7)?,
                expected_cash: r.get(8)?,
                variance: r.get(9)?,
                notes: r.get(10)?,
                backup_check_status: r.get(11)?,
                created_at: r.get(12)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
}

pub fn get(db: &Db, id: i64) -> Result<Option<DayClose>, DayCloseError> {
    db.with_conn(|c| -> Result<Option<DayClose>, DayCloseError> {
        let r = c
            .query_row(
                "SELECT id, date, user_id, opening_cash, cash_sales, cash_in, cash_out,
                        counted_cash, expected_cash, variance, notes,
                        backup_check_status, created_at
                 FROM day_close WHERE id = ?1",
                params![id],
                |row| {
                    Ok(DayClose {
                        id: row.get(0)?,
                        date: row.get(1)?,
                        user_id: row.get(2)?,
                        opening_cash: row.get(3)?,
                        cash_sales: row.get(4)?,
                        cash_in: row.get(5)?,
                        cash_out: row.get(6)?,
                        counted_cash: row.get(7)?,
                        expected_cash: row.get(8)?,
                        variance: row.get(9)?,
                        notes: row.get(10)?,
                        backup_check_status: row.get(11)?,
                        created_at: row.get(12)?,
                    })
                },
            )
            .optional()?;
        Ok(r)
    })
}

/// Owner-override delete of a day_close row (E52: owner can re-open a day).
pub fn admin_reopen(db: &Db, id: i64) -> Result<bool, DayCloseError> {
    db.with_conn(|c| -> Result<bool, DayCloseError> {
        let n = c.execute("DELETE FROM day_close WHERE id = ?1", params![id])?;
        Ok(n > 0)
    })
}

pub fn trigger_day_close(db: &Db, user_id: i64, req: NewDayClose) -> Result<i64, DayCloseError> {
    if req.opening_cash < 0 {
        return Err(DayCloseError::BadOpening);
    }
    if req.cash_in < 0 || req.cash_out < 0 {
        return Err(DayCloseError::BadDelta);
    }
    if req.counted_cash < 0 {
        return Err(DayCloseError::BadCounted);
    }
    let backup_status = match req.backup_decision.as_str() {
        "back_up" | "fresh" => "fresh",
        "skip" => "stale",
        other => return Err(DayCloseError::BadBackupDecision(other.into())),
    };
    let date = req.date.unwrap_or_else(today);
    // Resolve opening_cash default = last carry-forward.
    let opening = if req.opening_cash == 0 {
        last_opening_for(db, user_id, &date)?
    } else {
        req.opening_cash
    };

    let summary = cash_sales_for(db, user_id, &date)?;
    let expected = expected_cash(opening, summary.cash_sales_paise, req.cash_in, req.cash_out);
    let var = variance(req.counted_cash, expected);

    let id = db.with_conn_immediate(|c| -> Result<i64, DayCloseError> {
        let existing: Option<i64> = c
            .query_row(
                "SELECT id FROM day_close WHERE user_id = ?1 AND date = ?2",
                params![user_id, date],
                |r| r.get(0),
            )
            .optional()?;
        if existing.is_some() {
            return Err(DayCloseError::AlreadyClosed { date });
        }
        let id: i64 = c.query_row(
            "INSERT INTO day_close
                (date,user_id,opening_cash,cash_sales,cash_in,cash_out,
                 counted_cash,expected_cash,variance,notes,backup_check_status,created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
             RETURNING id",
            params![
                date,
                user_id,
                opening,
                summary.cash_sales_paise,
                req.cash_in,
                req.cash_out,
                req.counted_cash,
                expected,
                var,
                req.notes,
                backup_status,
                now(),
            ],
            |r| r.get(0),
        )?;
        Ok(id)
    })?;
    Ok(id)
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}
fn now() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

// -----------------------------------------------------------------------------
// Tauri command surface.
// -----------------------------------------------------------------------------

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_cash_sales_for(
    state: tauri::State<'_, AppState>,
    user_id: i64,
    date: String,
) -> AppResult<CashSalesSummary> {
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    cash_sales_for(db, user_id, &date).map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_last_opening_for(
    state: tauri::State<'_, AppState>,
    user_id: i64,
    date: String,
) -> AppResult<i64> {
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    last_opening_for(db, user_id, &date).map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_backup_gate_check(
    state: tauri::State<'_, AppState>,
    now_epoch_secs: Option<i64>,
) -> AppResult<BackupGate> {
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let now = now_epoch_secs.unwrap_or_else(|| chrono::Utc::now().timestamp());
    backup_gate_check(db, now).map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_trigger_day_close(
    state: tauri::State<'_, AppState>,
    req: NewDayClose,
) -> AppResult<i64> {
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let session = state.session.lock().map_err(|_| AppError::Internal("session lock poisoned".into()))?;
    let user = session.as_ref().ok_or(AppError::NotUnlocked)?;
    trigger_day_close(db, user.id, req).map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_lock_state(
    state: tauri::State<'_, AppState>,
    user_id: i64,
    date: String,
) -> AppResult<DayLockState> {
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    lock_state(db, user_id, &date).map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_list_day_close(state: tauri::State<'_, AppState>, limit: Option<i64>) -> AppResult<Vec<DayClose>> {
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    list(db, limit.unwrap_or(60)).map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_get_day_close(state: tauri::State<'_, AppState>, id: i64) -> AppResult<Option<DayClose>> {
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    get(db, id).map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn cmd_admin_reopen_day(state: tauri::State<'_, AppState>, id: i64) -> AppResult<bool> {
    let guard = state.db.lock().map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    admin_reopen(db, id).map_err(|e| AppError::Internal(e.to_string()))
}

// -----------------------------------------------------------------------------
// Unit tests.
// -----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::sales::{self, CartLine, NewSale, PaymentSplit};

    fn seed_basic(db: &Db) -> i64 {
        crate::session::__test_set_role(db, crate::session::Role::Owner);
        db.with_conn(|c| -> anyhow::Result<()> {
            c.execute(
                "INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length) VALUES ('Owner','owner',X'00',X'00',6)",
                [],
            )?;
            c.execute(
                "INSERT INTO items (sku_code, barcode, name, unit, units_per_box, retail_price, cost_price, is_active)
                 VALUES ('TEST-001','1234567890','Red','pc',1,10000,5000,1)",
                [],
            )?;
            c.execute("INSERT INTO locations (name) VALUES ('Main')", [])?;
            Ok(())
        })
        .unwrap();
        1
    }

    #[test]
    fn expected_cash_formula() {
        // E47: opening 500 + cash_sales 1200 + cash_in 100 - cash_out 200 = 1600.
        assert_eq!(expected_cash(500, 1200, 100, 200), 1600);
    }

    #[test]
    fn variance_signs() {
        // E50: counted < expected = negative variance (shortage).
        assert_eq!(variance(1500, 1600), -100);
        // E51: counted > expected = positive variance (overage).
        assert_eq!(variance(1700, 1600), 100);
        // Exact match.
        assert_eq!(variance(1600, 1600), 0);
    }

    #[test]
    fn backup_gate_never_backed_up() {
        let db = crate::db::Db::open_in_memory().expect("mem db");
        crate::session::__test_set_role(&db, crate::session::Role::Owner);
        db.with_conn(|c| -> anyhow::Result<()> {
            c.execute("INSERT OR REPLACE INTO settings (id, shop_name, last_backup_at) VALUES (1, 'Test', NULL)", [])?;
            Ok(())
        })
        .unwrap();
        let gate = backup_gate_check(&db, chrono::Utc::now().timestamp()).expect("gate");
        assert!(gate.needs_prompt);
        assert!(gate.last_backup_at.is_none());
        assert_eq!(gate.reason, "never");
    }

    #[test]
    fn backup_gate_stale_over_24h() {
        let db = crate::db::Db::open_in_memory().expect("mem db");
        crate::session::__test_set_role(&db, crate::session::Role::Owner);
        let now = chrono::Utc::now().timestamp();
        let stale = chrono::DateTime::from_timestamp(now - 26 * 3600, 0)
            .unwrap()
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();
        db.with_conn(|c| -> anyhow::Result<()> {
            c.execute(
                "INSERT OR REPLACE INTO settings (id, shop_name, last_backup_at) VALUES (1, 'Test', ?1)",
                params![stale],
            )?;
            Ok(())
        })
        .unwrap();
        let gate = backup_gate_check(&db, now).expect("gate");
        assert!(gate.needs_prompt);
        assert!(gate.age_hours.unwrap() >= 24.0);
    }

    #[test]
    fn backup_gate_fresh_under_24h() {
        let db = crate::db::Db::open_in_memory().expect("mem db");
        crate::session::__test_set_role(&db, crate::session::Role::Owner);
        let now = chrono::Utc::now().timestamp();
        let fresh = chrono::DateTime::from_timestamp(now - 3600, 0)
            .unwrap()
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();
        db.with_conn(|c| -> anyhow::Result<()> {
            c.execute(
                "INSERT OR REPLACE INTO settings (id, shop_name, last_backup_at) VALUES (1, 'Test', ?1)",
                params![fresh],
            )?;
            Ok(())
        })
        .unwrap();
        let gate = backup_gate_check(&db, now).expect("gate");
        assert!(!gate.needs_prompt);
        assert!(gate.age_hours.unwrap() < 24.0);
    }

    #[test]
    fn cash_sales_for_sums_only_cash_mode() {
        let db = crate::db::Db::open_in_memory().expect("mem db");
        let _ = seed_basic(&db);
        // Sale A: 100 cash + 200 upi = 300 paid.
        let _sid1 = sales::create_final_bill(
            &db,
            1,
            NewSale {
                customer_id: None,
                kind: "final".into(),
                date: Some("2026-06-19".into()),
                bill_discount: 0,
                paid_amount: 300,
                payment_modes: vec![
                    PaymentSplit { mode: "cash".into(), amount: 100 },
                    PaymentSplit { mode: "upi".into(), amount: 200 },
                ],
                validity_days: None,
                acknowledge_flag: false,
                lines: vec![CartLine {
                    item_id: 1,
                    qty: 1.0,
                    price: 300,
                    unit_type: "unit".into(),
                    line_discount: 0,
                    shade_note: None,
                }],
            },
        )
        .expect("sale a");
        // Sale B: 50 cash only = 50 paid.
        sales::create_final_bill(
            &db,
            1,
            NewSale {
                customer_id: None,
                kind: "final".into(),
                date: Some("2026-06-19".into()),
                bill_discount: 0,
                paid_amount: 50,
                payment_modes: vec![PaymentSplit { mode: "cash".into(), amount: 50 }],
                validity_days: None,
                acknowledge_flag: false,
                lines: vec![CartLine {
                    item_id: 1,
                    qty: 1.0,
                    price: 50,
                    unit_type: "unit".into(),
                    line_discount: 0,
                    shade_note: None,
                }],
            },
        )
        .expect("sale b");

        let sum = cash_sales_for(&db, 1, "2026-06-19").expect("summary");
        assert_eq!(sum.cash_sales_paise, 150);
        assert_eq!(sum.non_cash_sales_paise, 200);
        assert_eq!(sum.total_sales_paise, 350);
    }

    #[test]
    fn trigger_day_close_full_flow() {
        let db = crate::db::Db::open_in_memory().expect("mem db");
        let _ = seed_basic(&db);
        // Two cash sales for user 1 on 2026-06-19.
        for amt in [100, 200] {
            sales::create_final_bill(
                &db,
                1,
                NewSale {
                    customer_id: None,
                    kind: "final".into(),
                    date: Some("2026-06-19".into()),
                    bill_discount: 0,
                    paid_amount: amt,
                    payment_modes: vec![PaymentSplit { mode: "cash".into(), amount: amt }],
                    validity_days: None,
                    acknowledge_flag: false,
                    lines: vec![CartLine {
                        item_id: 1,
                        qty: 1.0,
                        price: amt,
                        unit_type: "unit".into(),
                        line_discount: 0,
                        shade_note: None,
                    }],
                },
            )
            .expect("sale");
        }

        let id = trigger_day_close(
            &db,
            1,
            NewDayClose {
                date: Some("2026-06-19".into()),
                opening_cash: 500,
                cash_in: 50,
                cash_out: 0,
                counted_cash: 850, // exactly expected (500+300+50)
                notes: Some("clean close".into()),
                backup_decision: "fresh".into(),
            },
        )
        .expect("day close");
        assert_eq!(id, 1);

        let row = get(&db, 1).expect("query").expect("exists");
        assert_eq!(row.cash_sales, 300);
        assert_eq!(row.opening_cash, 500);
        assert_eq!(row.cash_in, 50);
        assert_eq!(row.expected_cash, 850);
        assert_eq!(row.variance, 0);
        assert_eq!(row.backup_check_status, "fresh");

        // E52: cannot close the same day again.
        let res = trigger_day_close(
            &db,
            1,
            NewDayClose {
                date: Some("2026-06-19".into()),
                opening_cash: 0,
                cash_in: 0,
                cash_out: 0,
                counted_cash: 0,
                notes: None,
                backup_decision: "fresh".into(),
            },
        );
        assert!(matches!(res, Err(DayCloseError::AlreadyClosed { .. })));
    }

    #[test]
    fn trigger_day_close_default_opening_from_last_close() {
        let db = crate::db::Db::open_in_memory().expect("mem db");
        let _ = seed_basic(&db);
        // Yesterday's close leaves counted_cash=1000.
        db.with_conn(|c| -> anyhow::Result<()> {
            c.execute(
                "INSERT INTO day_close (date, user_id, opening_cash, cash_sales, cash_in,
                   cash_out, counted_cash, expected_cash, variance, backup_check_status)
                 VALUES ('2026-06-18', 1, 800, 200, 0, 0, 1000, 1000, 0, 'fresh')",
                [],
            )?;
            Ok(())
        })
        .unwrap();

        // Close today with opening_cash=0 → should default to 1000.
        let id = trigger_day_close(
            &db,
            1,
            NewDayClose {
                date: Some("2026-06-19".into()),
                opening_cash: 0,
                cash_in: 0,
                cash_out: 0,
                counted_cash: 1000,
                notes: None,
                backup_decision: "fresh".into(),
            },
        )
        .expect("close");
        let row = get(&db, id).expect("get").expect("row");
        assert_eq!(row.opening_cash, 1000, "carry-forward opening");
    }
}

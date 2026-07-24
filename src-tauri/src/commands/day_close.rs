//! Day-close commands (per-user end-of-day reconciliation).
//!
//! Mode is determined at runtime by active cashier count. Single cashier →
//! shop-level close per (day, location_id) with `user_id IS NULL`. Multiple
//! cashiers → per-cashier close per (day, location_id, user_id). Both modes
//! coexist via partial unique indexes (see `schema_final.sql` §I1 and
//! `db/mod.rs` M-INLINE-027).
//!
//! The `closing_cash_paise` formula is:
//!
//! ```text
//!     closing = opening_cash
//!             + cash_sales
//!             + cash_in
//!             - cash_out
//! ```
//!
//! `variance_paise = actual_cash_paise - closing_cash_paise`.
//!
//! Backup gate (E48 / §7.6): when `settings.last_backup_unix_ms` is NULL or older
//! than 24h, the frontend must prompt the operator to "Back up & close | Skip
//! once | Cancel close". The backend returns a `BackupGate` decision the frontend
//! renders; the actual save accepts `backup_decision` but no longer stores it.

use chrono::Utc;
use rusqlite::params;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::commands::auth::AppState;
use crate::db::list::{paged_query, sanitize_dir, sanitize_sort, ListPage, ListQuery};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::security::ipc_auth;

// -----------------------------------------------------------------------------
// Public types.
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct DayClose {
    pub id: i64,
    pub day: String,
    pub location_id: i64,
    /// `None` marks a shop-level close (single-cashier mode). Some
    /// `user_id` marks a per-cashier close (multi-cashier mode).
    pub user_id: Option<i64>,
    pub opening_cash_paise: i64,
    pub cash_sales_paise: i64,
    pub card_sales_paise: i64,
    pub upi_sales_paise: i64,
    pub expenses_paise: i64,
    pub cash_in_paise: i64,
    pub cash_out_paise: i64,
    pub closing_cash_paise: i64,
    pub actual_cash_paise: i64,
    pub variance_paise: i64,
    pub note: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Mode chosen at runtime by `count_active_cashiers` at the time of close.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub enum DayCloseMode {
    /// Single active cashier → one close per `(day, location_id)` with
    /// `user_id = NULL`.
    Shop,
    /// Two or more active cashiers → one close per cashier
    /// `(day, location_id, user_id)`.
    Cashier,
}

/// Totals for a single close row, normalized for the UI preview.
/// `user_id` is `None` for the shop-level row, `Some(id)` for a per-cashier row.
#[derive(Debug, Clone, Serialize)]
pub struct DayCloseTotals {
    pub user_id: Option<i64>,
    pub user_name: String,
    pub opening_cash_paise: i64,
    pub cash_sales_paise: i64,
    pub card_sales_paise: i64,
    pub upi_sales_paise: i64,
    pub cash_in_paise: i64,
    pub cash_out_paise: i64,
    pub closing_cash_paise: i64,
    pub actual_cash_paise: i64,
    pub variance_paise: i64,
}

/// Returned to the UI after a successful `cmd_trigger_day_close`.
/// In `Shop` mode, `per_cashier` is empty and `shop_total` is the close row.
/// In `Cashier` mode, `per_cashier` lists every cashier's row and
/// `shop_total` is the element-wise sum of `per_cashier`.
#[derive(Debug, Clone, Serialize)]
pub struct DayClosePreview {
    pub mode: DayCloseMode,
    pub day: String,
    pub location_id: i64,
    pub shop_total: DayCloseTotals,
    pub per_cashier: Vec<DayCloseTotals>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CashSalesSummary {
    pub date: String,
    pub user_id: i64,
    pub cash_sales_paise: i64,
    pub card_sales_paise: i64,
    pub upi_sales_paise: i64,
    pub non_cash_sales_paise: i64,
    pub total_sales_paise: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupGate {
    pub needs_prompt: bool,
    pub age_hours: Option<f64>,
    pub reason: String,
    pub last_backup_unix_ms: Option<i64>,
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

impl From<DayCloseError> for AppError {
    fn from(error: DayCloseError) -> Self {
        match error {
            DayCloseError::BadOpening => AppError::Validation("Bad opening balance".into()),
            DayCloseError::BadDelta => AppError::Validation("Bad cash delta".into()),
            DayCloseError::BadCounted => AppError::Validation("Bad counted cash".into()),
            DayCloseError::BadBackupDecision(s) => {
                AppError::Validation(format!("Bad backup decision: {s}"))
            }
            DayCloseError::AlreadyClosed { date } => {
                AppError::Conflict(format!("Day {date} already closed"))
            }
            DayCloseError::Db(error) => AppError::Db(error),
            DayCloseError::Other(error) => AppError::Internal(error.to_string()),
        }
    }
}

// -----------------------------------------------------------------------------
// Pure helpers.
// -----------------------------------------------------------------------------

pub fn closing_cash(opening: i64, cash_sales: i64, cash_in: i64, cash_out: i64) -> i64 {
    opening + cash_sales + cash_in - cash_out
}

/// Variance within this threshold (₹5) is considered normal cash handling noise.
pub fn variance(actual: i64, closing: i64) -> i64 {
    actual - closing
}

// -----------------------------------------------------------------------------
// Reads / gate / save.
// -----------------------------------------------------------------------------

/// Sum today's sales for a single user from the normalized `sale_payments` table.
/// Only cash, card and upi modes are tracked in the day-close columns.
pub fn cash_sales_for(
    db: &Db,
    user_id: i64,
    date: &str,
) -> Result<CashSalesSummary, DayCloseError> {
    db.with_conn(|c| -> Result<CashSalesSummary, DayCloseError> {
        let mut stmt = c.prepare(
            "SELECT sp.mode, sp.amount_paise
             FROM sale_payments sp
             JOIN sales s ON s.id = sp.sale_id
             WHERE s.user_id = ?1
               AND s.date = ?2
               AND s.status = 'final'",
        )?;
        let rows = stmt.query_map(params![user_id, date], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        let mut cash: i64 = 0;
        let mut card: i64 = 0;
        let mut upi: i64 = 0;
        let mut other: i64 = 0;
        for row in rows {
            let (mode, amount) = row?;
            match mode.as_str() {
                "cash" => cash += amount,
                "card" => card += amount,
                "upi" => upi += amount,
                _ => other += amount,
            }
        }
        let total = cash + card + upi + other;
        Ok(CashSalesSummary {
            date: date.into(),
            user_id,
            cash_sales_paise: cash,
            card_sales_paise: card,
            upi_sales_paise: upi,
            non_cash_sales_paise: total - cash,
            total_sales_paise: total,
        })
    })
}

/// Returns the previous closing opening_cash for this user (most recent
/// day_close before `day`). Defaults to 0.
pub fn last_opening_for(db: &Db, user_id: i64, day: &str) -> Result<i64, DayCloseError> {
    db.with_conn(|c| -> Result<i64, DayCloseError> {
        let v: Option<i64> = c
            .query_row(
                "SELECT actual_cash_paise FROM day_close
                 WHERE user_id = ?1 AND day < ?2
                 ORDER BY day DESC LIMIT 1",
                params![user_id, day],
                |r| r.get(0),
            )
            .optional()?;
        Ok(v.unwrap_or(0))
    })
}

/// Check the backup gate (E48). Returns gate info so the UI can render the
/// "Back up & close | Skip once | Cancel close" prompt (E49).
pub fn backup_gate_check(db: &Db, now_epoch_ms: i64) -> Result<BackupGate, DayCloseError> {
    db.with_conn(|c| -> Result<BackupGate, DayCloseError> {
        let v: Option<Option<i64>> = c
            .query_row(
                "SELECT last_backup_unix_ms FROM settings WHERE id = 1",
                [],
                |r| r.get(0),
            )
            .optional()?;
        let last = v.flatten();
        let age = match last {
            Some(ms) => {
                let ms_diff = now_epoch_ms - ms;
                Some((ms_diff as f64) / (3600.0 * 1000.0))
            }
            None => None,
        };
        let needs_prompt = match age {
            None => true,
            Some(h) if h >= 24.0 => true,
            Some(_) => false,
        };
        let reason = match age {
            None => "never".into(),
            Some(h) if h >= 24.0 => format!("stale_{}h", h.round()),
            Some(h) => format!("fresh_{}h", h.round()),
        };
        Ok(BackupGate {
            needs_prompt,
            age_hours: age,
            reason,
            last_backup_unix_ms: last,
        })
    })
}

/// Lock state for a (user, day). After a cashier closes a day, that user's
/// sales for that day are read-only to that user. Owner override is allowed.
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
                "SELECT id FROM day_close WHERE user_id = ?1 AND day = ?2",
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
            "SELECT id, day, location_id, user_id, opening_cash_paise, cash_sales_paise,
                    card_sales_paise, upi_sales_paise, expenses_paise, closing_cash_paise,
                    actual_cash_paise, variance_paise, note, created_at, updated_at,
                    cash_in_paise, cash_out_paise
             FROM day_close ORDER BY day DESC, id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], row_to_day_close)?;
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
                "SELECT id, day, location_id, user_id, opening_cash_paise, cash_sales_paise,
                        card_sales_paise, upi_sales_paise, expenses_paise, closing_cash_paise,
                        actual_cash_paise, variance_paise, note, created_at, updated_at,
                        cash_in_paise, cash_out_paise
                 FROM day_close WHERE id = ?1",
                params![id],
                row_to_day_close,
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
    if !matches!(req.backup_decision.as_str(), "back_up" | "skip" | "fresh") {
        return Err(DayCloseError::BadBackupDecision(req.backup_decision));
    }
    let day = req.date.unwrap_or_else(today);
    // Resolve opening_cash default = last carry-forward.
    let opening = if req.opening_cash == 0 {
        last_opening_for(db, user_id, &day)?
    } else {
        req.opening_cash
    };

    let summary = cash_sales_for(db, user_id, &day)?;
    let closing = closing_cash(opening, summary.cash_sales_paise, req.cash_in, req.cash_out);
    let var = variance(req.counted_cash, closing);
    let location_id = default_location(db)?;
    let now = now_ms();

    let id = db.with_conn_immediate(|c| -> Result<i64, DayCloseError> {
        let existing: Option<i64> = c
            .query_row(
                "SELECT id FROM day_close WHERE day = ?1 AND location_id = ?2 AND user_id = ?3",
                params![day, location_id, user_id],
                |r| r.get(0),
            )
            .optional()?;
        if existing.is_some() {
            return Err(DayCloseError::AlreadyClosed { date: day });
        }
        let id: i64 = c.query_row(
            "INSERT INTO day_close
                (day, location_id, user_id, opening_cash_paise, cash_sales_paise, card_sales_paise,
                 upi_sales_paise, expenses_paise, closing_cash_paise, actual_cash_paise,
                 variance_paise, note, created_at, updated_at,
                 cash_in_paise, cash_out_paise)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13, ?14, ?15)
             RETURNING id",
            params![
                day,
                location_id,
                user_id,
                opening,
                summary.cash_sales_paise,
                summary.card_sales_paise,
                summary.upi_sales_paise,
                0i64, // expenses_paise: 0 in v1; replaced by cash_movement_categories in Phase B
                closing,
                req.counted_cash,
                var,
                req.notes,
                now,
                req.cash_in,  // B3 fix: was previously dropped
                req.cash_out, // B2 fix: was incorrectly bound to expenses_paise
            ],
            |r| r.get(0),
        )?;
        Ok(id)
    })?;
    Ok(id)
}

/// Count of currently active cashiers — drives the runtime mode dispatch in
/// `trigger_day_close_auto_mode`. Single active cashier → shop-level close;
/// two or more → per-cashier close.
pub fn count_active_cashiers(db: &Db) -> Result<i64, DayCloseError> {
    db.with_conn(|c| -> Result<i64, DayCloseError> {
        let n: i64 = c.query_row(
            "SELECT COUNT(*) FROM users WHERE role = 'cashier' AND is_active = 1",
            [],
            |r| r.get(0),
        )?;
        Ok(n)
    })
}

/// Shop-level close: inserts a row with `user_id = NULL`, enforcing
/// uniqueness on `(day, location_id)` via the partial unique index
/// `day_close_shop_uniq`. The caller (cmd path) is responsible for choosing
/// this path — it is the right choice when `count_active_cashiers <= 1`.
pub fn trigger_day_close_shop(db: &Db, req: NewDayClose) -> Result<i64, DayCloseError> {
    if req.opening_cash < 0 {
        return Err(DayCloseError::BadOpening);
    }
    if req.cash_in < 0 || req.cash_out < 0 {
        return Err(DayCloseError::BadDelta);
    }
    if req.counted_cash < 0 {
        return Err(DayCloseError::BadCounted);
    }
    if !matches!(req.backup_decision.as_str(), "back_up" | "skip" | "fresh") {
        return Err(DayCloseError::BadBackupDecision(req.backup_decision));
    }
    let day = req.date.unwrap_or_else(today);
    // The opening/closing math here uses the only active cashier's previous
    // close as the carry-forward. Sales totals are still per-day totals for
    // the location (the active cashier owns the day's activity).
    let cashier_seed = db.with_conn(|c| -> Result<i64, DayCloseError> {
        let id: i64 = c
            .query_row(
                "SELECT id FROM users WHERE role = 'cashier' AND is_active = 1 \
                 ORDER BY id LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| DayCloseError::Other(anyhow::anyhow!("no active cashier")))?;
        Ok(id)
    })?;
    let opening = if req.opening_cash == 0 {
        last_opening_for(db, cashier_seed, &day)?
    } else {
        req.opening_cash
    };
    let summary = cash_sales_for(db, cashier_seed, &day)?;
    let closing = closing_cash(opening, summary.cash_sales_paise, req.cash_in, req.cash_out);
    let var = variance(req.counted_cash, closing);
    let location_id = default_location(db)?;
    let now = now_ms();

    let id = db.with_conn_immediate(|c| -> Result<i64, DayCloseError> {
        let existing: Option<i64> = c
            .query_row(
                "SELECT id FROM day_close WHERE day = ?1 AND location_id = ?2 AND user_id IS NULL",
                params![day, location_id],
                |r| r.get(0),
            )
            .optional()?;
        if existing.is_some() {
            return Err(DayCloseError::AlreadyClosed { date: day });
        }
        let id: i64 = c.query_row(
            "INSERT INTO day_close
                (day, location_id, user_id, opening_cash_paise, cash_sales_paise, card_sales_paise,
                 upi_sales_paise, expenses_paise, closing_cash_paise, actual_cash_paise,
                 variance_paise, note, created_at, updated_at,
                 cash_in_paise, cash_out_paise)
             VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?13, ?14)
             RETURNING id",
            params![
                day,
                location_id,
                opening,
                summary.cash_sales_paise,
                summary.card_sales_paise,
                summary.upi_sales_paise,
                0i64,
                closing,
                req.counted_cash,
                var,
                req.notes,
                now,
                req.cash_in,
                req.cash_out,
            ],
            |r| r.get(0),
        )?;
        Ok(id)
    })?;
    Ok(id)
}

/// Dispatch on active cashier count and run the matching insert. The
/// returned `DayClosePreview` is what the UI needs to render both the
/// shop-level section and (when 2+ cashiers) the per-cashier breakdown.
pub fn trigger_day_close_auto_mode(
    db: &Db,
    user_id: i64,
    req: NewDayClose,
) -> Result<DayClosePreview, DayCloseError> {
    let day = req.date.clone().unwrap_or_else(today);
    let location_id = default_location(db)?;
    let cashier_count = count_active_cashiers(db)?;
    if cashier_count <= 1 {
        let id = trigger_day_close_shop(db, req)?;
        let row = get(db, id)?
            .ok_or_else(|| DayCloseError::Other(anyhow::anyhow!("inserted row missing")))?;
        let totals = row_to_totals(&row, "Shop");
        return Ok(DayClosePreview {
            mode: DayCloseMode::Shop,
            day,
            location_id,
            shop_total: totals,
            per_cashier: vec![],
        });
    }
    // Per-cashier mode.
    let _id = trigger_day_close(db, user_id, req)?;
    let rows = list_cashier_closes(db, &day, location_id)?;
    let per_cashier: Vec<DayCloseTotals> = rows
        .iter()
        .map(|r| row_to_totals(r, &user_name_for(db, r.user_id)))
        .collect();
    let shop_total = sum_totals(&per_cashier);
    Ok(DayClosePreview {
        mode: DayCloseMode::Cashier,
        day,
        location_id,
        shop_total,
        per_cashier,
    })
}

fn list_cashier_closes(
    db: &Db,
    day: &str,
    location_id: i64,
) -> Result<Vec<DayClose>, DayCloseError> {
    db.with_conn(|c| -> Result<Vec<DayClose>, DayCloseError> {
        let mut stmt = c.prepare(
            "SELECT id, day, location_id, user_id, opening_cash_paise, cash_sales_paise,
                    card_sales_paise, upi_sales_paise, expenses_paise, closing_cash_paise,
                    actual_cash_paise, variance_paise, note, created_at, updated_at,
                    cash_in_paise, cash_out_paise
             FROM day_close
             WHERE day = ?1 AND location_id = ?2 AND user_id IS NOT NULL
             ORDER BY user_id ASC",
        )?;
        let rows = stmt.query_map(params![day, location_id], row_to_day_close)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
}

fn user_name_for(db: &Db, user_id: Option<i64>) -> String {
    let Some(uid) = user_id else {
        return "Shop".into();
    };
    db.with_conn(|c| -> Result<String, DayCloseError> {
        let name: Option<String> = c
            .query_row(
                "SELECT name FROM users WHERE id = ?1",
                params![uid],
                |r| r.get(0),
            )
            .optional()?;
        Ok(name.unwrap_or_else(|| format!("user#{uid}")))
    })
    .unwrap_or_else(|_| format!("user#{uid}"))
}

fn row_to_totals(r: &DayClose, user_name: &str) -> DayCloseTotals {
    DayCloseTotals {
        user_id: r.user_id,
        user_name: user_name.to_string(),
        opening_cash_paise: r.opening_cash_paise,
        cash_sales_paise: r.cash_sales_paise,
        card_sales_paise: r.card_sales_paise,
        upi_sales_paise: r.upi_sales_paise,
        cash_in_paise: r.cash_in_paise,
        cash_out_paise: r.cash_out_paise,
        closing_cash_paise: r.closing_cash_paise,
        actual_cash_paise: r.actual_cash_paise,
        variance_paise: r.variance_paise,
    }
}

fn sum_totals(rows: &[DayCloseTotals]) -> DayCloseTotals {
    let mut t = DayCloseTotals {
        user_id: None,
        user_name: "Shop".into(),
        opening_cash_paise: 0,
        cash_sales_paise: 0,
        card_sales_paise: 0,
        upi_sales_paise: 0,
        cash_in_paise: 0,
        cash_out_paise: 0,
        closing_cash_paise: 0,
        actual_cash_paise: 0,
        variance_paise: 0,
    };
    for r in rows {
        t.opening_cash_paise += r.opening_cash_paise;
        t.cash_sales_paise += r.cash_sales_paise;
        t.card_sales_paise += r.card_sales_paise;
        t.upi_sales_paise += r.upi_sales_paise;
        t.cash_in_paise += r.cash_in_paise;
        t.cash_out_paise += r.cash_out_paise;
        t.closing_cash_paise += r.closing_cash_paise;
        t.actual_cash_paise += r.actual_cash_paise;
        t.variance_paise += r.variance_paise;
    }
    t
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}
fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn default_location(db: &Db) -> Result<i64, DayCloseError> {
    db.with_conn(|c| -> Result<i64, DayCloseError> {
        Ok(c.query_row(
            "SELECT id FROM locations WHERE is_active = 1 ORDER BY id LIMIT 1",
            [],
            |r| r.get(0),
        )?)
    })
}

// -----------------------------------------------------------------------------
// Tauri command surface.
// -----------------------------------------------------------------------------

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_cash_sales_for(
    state: tauri::State<'_, AppState>,
    user_id: i64,
    date: String,
) -> AppResult<CashSalesSummary> {
    ipc_auth::authorize_err("cmd_cash_sales_for", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    Ok(cash_sales_for(db, user_id, &date)?)
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_last_opening_for(
    state: tauri::State<'_, AppState>,
    user_id: i64,
    date: String,
) -> AppResult<i64> {
    ipc_auth::authorize_err("cmd_last_opening_for", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    Ok(last_opening_for(db, user_id, &date)?)
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_backup_gate_check(
    state: tauri::State<'_, AppState>,
    now_epoch_ms: Option<i64>,
) -> AppResult<BackupGate> {
    ipc_auth::authorize_err("cmd_backup_gate_check", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let now = now_epoch_ms.unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
    Ok(backup_gate_check(db, now)?)
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_trigger_day_close<R: tauri::Runtime>(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle<R>,
    req: NewDayClose,
) -> AppResult<DayClosePreview> {
    ipc_auth::authorize_err("cmd_trigger_day_close", state.inner())?;

    // ponytail: do_backup first; does NOT touch state.db so safe before lock.
    if req.backup_decision == "back_up" {
        crate::commands::backup::do_backup(state.inner(), &app, None)
            .map_err(|e| AppError::Internal(format!("backup before day close failed: {e}")))?;
    }

    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let session = state
        .session
        .lock()
        .map_err(|_| AppError::Internal("session lock poisoned".into()))?;
    let user = session.as_ref().ok_or(AppError::NotUnlocked)?;
    Ok(trigger_day_close_auto_mode(db, user.id, req)?)
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_count_active_cashiers(state: tauri::State<'_, AppState>) -> AppResult<i64> {
    ipc_auth::authorize_err("cmd_count_active_cashiers", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    Ok(count_active_cashiers(db)?)
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_lock_state(
    state: tauri::State<'_, AppState>,
    user_id: i64,
    date: String,
) -> AppResult<DayLockState> {
    ipc_auth::authorize_err("cmd_lock_state", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    Ok(lock_state(db, user_id, &date)?)
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_list_day_close(
    state: tauri::State<'_, AppState>,
    limit: Option<i64>,
) -> AppResult<Vec<DayClose>> {
    ipc_auth::authorize_err("cmd_list_day_close", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    Ok(list(db, limit.unwrap_or(60))?)
}

const DAY_CLOSE_SORT_WHITELIST: &[&str] =
    &["day", "created_at", "closing_cash_paise", "variance_paise"];

fn row_to_day_close(r: &rusqlite::Row<'_>) -> rusqlite::Result<DayClose> {
    Ok(DayClose {
        id: r.get(0)?,
        day: r.get(1)?,
        location_id: r.get(2)?,
        user_id: r.get::<_, Option<i64>>(3)?,
        opening_cash_paise: r.get(4)?,
        cash_sales_paise: r.get(5)?,
        card_sales_paise: r.get(6)?,
        upi_sales_paise: r.get(7)?,
        expenses_paise: r.get(8)?,
        closing_cash_paise: r.get(9)?,
        actual_cash_paise: r.get(10)?,
        variance_paise: r.get(11)?,
        note: r.get(12)?,
        created_at: r.get::<_, i64>(13)?.to_string(),
        updated_at: r.get::<_, i64>(14)?.to_string(),
        cash_in_paise: r.get(15)?,
        cash_out_paise: r.get(16)?,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_list_day_close_paged(
    state: tauri::State<'_, AppState>,
    query: ListQuery,
) -> AppResult<ListPage<DayClose>> {
    ipc_auth::authorize_err("cmd_list_day_close_paged", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    let limit = query.limit.unwrap_or(25).clamp(1, 100);
    let offset = query.offset.unwrap_or(0).max(0);
    let sort_field =
        sanitize_sort(query.sort_field.as_deref(), DAY_CLOSE_SORT_WHITELIST, "day");
    let sort_dir = sanitize_dir(query.sort_dir.as_deref());

    db.with_raw(|c| {
        let where_refs: Vec<&str> = Vec::new();
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        let order_by = format!(
            " ORDER BY {} COLLATE NOCASE {} LIMIT ? OFFSET ?",
            sort_field, sort_dir
        );
        params.push(Box::new(limit));
        params.push(Box::new(offset));

        let base_select = "SELECT id, day, location_id, user_id, opening_cash_paise, \
                           cash_sales_paise, card_sales_paise, upi_sales_paise, expenses_paise, \
                           closing_cash_paise, actual_cash_paise, variance_paise, note, \
                           created_at, updated_at, cash_in_paise, cash_out_paise \
                           FROM day_close";
        let count_select = "SELECT COUNT(*) FROM day_close";

        let (rows, total) = paged_query(
            c,
            base_select,
            count_select,
            &where_refs,
            &order_by,
            &params,
            row_to_day_close,
        )?;
        Ok(ListPage { rows, total })
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_get_day_close(
    state: tauri::State<'_, AppState>,
    id: i64,
) -> AppResult<Option<DayClose>> {
    ipc_auth::authorize_err("cmd_get_day_close", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    Ok(get(db, id)?)
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_admin_reopen_day(state: tauri::State<'_, AppState>, id: i64) -> AppResult<bool> {
    ipc_auth::authorize_err("cmd_admin_reopen_day", state.inner())?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    Ok(admin_reopen(db, id)?)
}

// -----------------------------------------------------------------------------
// Unit tests.
// -----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::sales::{self, CartLine, NewSale, PaymentSplit};

    fn seed_basic(db: &Db) -> i64 {

        db.with_conn(|c| -> anyhow::Result<()> {
            c.execute(
                "INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length, created_at, updated_at)
                 VALUES ('Owner','owner',X'00',X'00',6,0,0)",
                [],
            )?;
            c.execute(
                "INSERT INTO items (sku_code, barcode, name, unit_code, unit_label, retail_price_paise, cost_paise, is_active, created_at, updated_at)
                 VALUES ('TEST-001','1234567890','Red','pc','Piece',10000,5000,1,0,0)",
                [],
            )?;
            c.execute(
                "INSERT INTO locations (name, zone, is_default, is_active, created_at, updated_at) VALUES ('Main',NULL,1,1,0,0)",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        1
    }

    #[test]
    fn closing_cash_formula() {
        // E47: opening 500 + cash_sales 1200 + cash_in 100 - cash_out 200 = 1600.
        assert_eq!(closing_cash(500, 1200, 100, 200), 1600);
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

        db.with_conn(|c| -> anyhow::Result<()> {
            c.execute(
                "INSERT OR REPLACE INTO settings (id, shop_name, last_backup_unix_ms, created_at, updated_at) VALUES (1, 'Test', NULL, 0, 0)",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        let gate = backup_gate_check(&db, chrono::Utc::now().timestamp_millis()).expect("gate");
        assert!(gate.needs_prompt);
        assert!(gate.last_backup_unix_ms.is_none());
        assert_eq!(gate.reason, "never");
    }

    #[test]
    fn backup_gate_stale_over_24h() {
        let db = crate::db::Db::open_in_memory().expect("mem db");

        let now = chrono::Utc::now().timestamp_millis();
        let stale = chrono::DateTime::from_timestamp_millis(now - 26 * 3600 * 1000)
            .unwrap()
            .timestamp_millis();
        db.with_conn(|c| -> anyhow::Result<()> {
            c.execute(
                "INSERT OR REPLACE INTO settings (id, shop_name, last_backup_unix_ms, created_at, updated_at) VALUES (1, 'Test', ?1, 0, 0)",
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

        let now = chrono::Utc::now().timestamp_millis();
        let fresh = chrono::DateTime::from_timestamp_millis(now - 3600 * 1000)
            .unwrap()
            .timestamp_millis();
        db.with_conn(|c| -> anyhow::Result<()> {
            c.execute(
                "INSERT OR REPLACE INTO settings (id, shop_name, last_backup_unix_ms, created_at, updated_at) VALUES (1, 'Test', ?1, 0, 0)",
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
                    PaymentSplit {
                        mode: "cash".into(),
                        amount: 100,
                    },
                    PaymentSplit {
                        mode: "upi".into(),
                        amount: 200,
                    },
                ],
                validity_days: None,
                acknowledge_flag: false,
                lines: vec![CartLine {
                    kind: "item".into(),
                    item_id: Some(1),
                    formula_id: None,
                    display_name: None,
                    qty: 1.0,
                    price: 300,
                    unit_type: "pcs".into(),
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
                payment_modes: vec![PaymentSplit {
                    mode: "cash".into(),
                    amount: 50,
                }],
                validity_days: None,
                acknowledge_flag: false,
                lines: vec![CartLine {
                    kind: "item".into(),
                    item_id: Some(1),
                    formula_id: None,
                    display_name: None,
                    qty: 1.0,
                    price: 50,
                    unit_type: "pcs".into(),
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
                    payment_modes: vec![PaymentSplit {
                        mode: "cash".into(),
                        amount: amt,
                    }],
                    validity_days: None,
                    acknowledge_flag: false,
                    lines: vec![CartLine {
                        kind: "item".into(),
                        item_id: Some(1),
                        formula_id: None,
                        display_name: None,
                        qty: 1.0,
                        price: amt,
                        unit_type: "pcs".into(),
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
                counted_cash: 850, // exactly closing (500+300+50)
                notes: Some("clean close".into()),
                backup_decision: "fresh".into(),
            },
        )
        .expect("day close");
        assert_eq!(id, 1);

        let row = get(&db, 1).expect("query").expect("exists");
        assert_eq!(row.cash_sales_paise, 300);
        assert_eq!(row.opening_cash_paise, 500);
        assert_eq!(row.closing_cash_paise, 850);
        assert_eq!(row.actual_cash_paise, 850);
        assert_eq!(row.variance_paise, 0);
        assert_eq!(row.note, Some("clean close".into()));

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
        // Yesterday's close leaves actual_cash_paise = 1000.
        db.with_conn(|c| -> anyhow::Result<()> {
            c.execute(
                "INSERT INTO day_close (day, location_id, user_id, opening_cash_paise, cash_sales_paise,
                   card_sales_paise, upi_sales_paise, expenses_paise, closing_cash_paise,
                   actual_cash_paise, variance_paise, note, created_at, updated_at)
                 VALUES ('2026-06-18', 1, 1, 800, 200, 0, 0, 0, 1000, 1000, 0, 'yesterday', 0, 0)",
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
        assert_eq!(row.opening_cash_paise, 1000, "carry-forward opening");
    }
}

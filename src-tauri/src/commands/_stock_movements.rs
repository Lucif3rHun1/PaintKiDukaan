//! Typed helper for appending rows to `stock_movements`.
//!
//! Replaces 10 hand-rolled `INSERT INTO stock_movements` SQL sites with one
//! call that resolves `kind_id` from `stock_movement_kinds.code` and falls back
//! on `sale_unit_id` from `items.sell_unit_id` (then `pcs`).
//!
//! `created_at` and `created_by` are caller-supplied rather than computed
//! here because some sites (sale return in `sales.rs`) commit a date decided
//! outside the transaction and tests need exact timestamps.
//!
//! Returns `rusqlite::Error` so the `?` operator flows naturally into the
//! existing `with_conn_immediate` / `with_tx` closures — every error type
//! those closures bubble out (`SaleError`, `PurchaseError`, `ReturnError`,
//! `AppError`) already has `From<rusqlite::Error>` defined.
//!
//! ponytail: kept private to `commands/`; not re-exported to the app crate root.

use rusqlite::{params, Connection};

/// Movement kinds accepted by `insert_stock_movement`. Maps to the
/// `stock_movement_kinds.code` lookup column.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StockMovementKind {
    Sale,
    Purchase,
    Return,
    Adjustment,
}

impl StockMovementKind {
    /// String code stored in `stock_movement_kinds.code` and used in the
    /// `ref_kind` CHECK constraint on `stock_movements`.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Sale => "sale",
            Self::Purchase => "purchase",
            Self::Return => "return",
            Self::Adjustment => "adjustment",
        }
    }
}

/// Append a single `stock_movements` row. Returns the new row id.
///
/// `tx` may be an open `db.with_tx` / `db.with_conn_immediate` handle or a
/// raw `db.with_conn` connection — both pass `&rusqlite::Connection` in this
/// codebase.
///
/// Column ordering matches the `stock_movements` schema
/// (`db/schema_final.sql:1106-1118`). The two subqueries resolve `kind_id`
/// and `sale_unit_id` so callers never compute either.
pub fn insert_stock_movement(
    tx: &Connection,
    item_id: i64,
    location_id: i64,
    qty: f64,
    kind: StockMovementKind,
    ref_id: Option<i64>,
    note: Option<&str>,
    created_at: i64,
    created_by: i64,
) -> Result<i64, rusqlite::Error> {
    tx.execute(
        "INSERT INTO stock_movements \
            (item_id, location_id, kind_id, qty, sale_unit_id, ref_kind, ref_id, note, created_at, created_by) \
         VALUES (?1, ?2, \
            (SELECT id FROM stock_movement_kinds WHERE code = ?4), \
            ?3, \
            COALESCE((SELECT sell_unit_id FROM items WHERE id = ?1), (SELECT id FROM sale_units WHERE code = 'pcs')), \
            ?4, ?5, ?6, ?7, ?8)",
        params![
            item_id,
            location_id,
            qty,
            kind.code(),
            ref_id,
            note,
            created_at,
            created_by,
        ],
    )?;
    Ok(tx.last_insert_rowid())
}

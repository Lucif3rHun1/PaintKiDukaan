use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::auth::AppState;
use crate::error::{AppError, AppResult};
use crate::security::ipc_auth;
use crate::session::{current_user, require_role, Role};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Printer {
    pub id: i64,
    pub name: String,
    pub use_case: String,
    pub connection_type: String,
    pub address: String,
    pub driver_name: Option<String>,
    pub port_name: Option<String>,
    pub is_default: bool,
    pub label_width_mm: Option<i64>,
    pub label_height_mm: Option<i64>,
    pub paper_size: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct NewPrinter {
    pub name: String,
    pub use_case: String,
    pub connection_type: String,
    pub address: String,
    pub driver_name: Option<String>,
    pub port_name: Option<String>,
    pub is_default: bool,
    pub label_width_mm: Option<i64>,
    pub label_height_mm: Option<i64>,
    pub paper_size: Option<String>,
}

pub const ALLOWED_USE_CASES: &[&str] = &["receipt", "label"];
pub const ALLOWED_CONN_TYPES: &[&str] = &["usb", "bluetooth", "network", "serial", "system"];
pub const ALLOWED_PAPER_SIZES: &[&str] = &["thermal-58mm", "thermal-80mm", "a4", "a5"];
pub const DEFAULT_RECEIPT_PAPER: &str = "a4";

fn validate(input: &NewPrinter) -> AppResult<()> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("printer name is required".into()));
    }
    let use_case = input.use_case.to_lowercase();
    if !ALLOWED_USE_CASES.contains(&use_case.as_str()) {
        return Err(AppError::Validation(format!(
            "use_case must be one of {:?}",
            ALLOWED_USE_CASES
        )));
    }
    let conn = input.connection_type.to_lowercase();
    if !ALLOWED_CONN_TYPES.contains(&conn.as_str()) {
        return Err(AppError::Validation(format!(
            "connection_type must be one of {:?}",
            ALLOWED_CONN_TYPES
        )));
    }
    match use_case.as_str() {
        "label" => {
            // Label dimensions are NOT required at the printer level —
            // the per-item stock size is authoritative. We just sanity-check
            // any values that WERE provided.
            if let (Some(w), Some(h)) = (input.label_width_mm, input.label_height_mm) {
                if w <= 0 || h <= 0 {
                    return Err(AppError::Validation(
                        "label dimensions must be positive".into(),
                    ));
                }
            }
            if input.paper_size.is_some() {
                return Err(AppError::Validation(
                    "label printer must not have paper_size".into(),
                ));
            }
        }
        "receipt" => {
            // Default paper size if caller didn't specify (A4).
            if let Some(ps) = &input.paper_size {
                if !ALLOWED_PAPER_SIZES.contains(&ps.to_lowercase().as_str()) {
                    return Err(AppError::Validation(format!(
                        "paper_size must be one of {:?}",
                        ALLOWED_PAPER_SIZES
                    )));
                }
            }
            if input.label_width_mm.is_some() || input.label_height_mm.is_some() {
                return Err(AppError::Validation(
                    "receipt printer must not have label dimensions".into(),
                ));
            }
        }
        _ => unreachable!(),
    }
    Ok(())
}

const SELECT_PRINTER: &str = "SELECT p.id, p.name, p.use_case, p.connection_type, p.address, p.driver_name, p.port_name, p.is_default, m.label_width_mm, m.label_height_mm, m.paper_size FROM printers p LEFT JOIN printer_mappings m ON m.printer_id = p.id";

fn row_to_printer(r: &rusqlite::Row) -> rusqlite::Result<Printer> {
    Ok(Printer {
        id: r.get(0)?,
        name: r.get(1)?,
        use_case: r.get(2)?,
        connection_type: r.get(3)?,
        address: r.get(4)?,
        driver_name: r.get(5)?,
        port_name: r.get(6)?,
        is_default: r.get::<_, i64>(7)? != 0,
        label_width_mm: r.get(8)?,
        label_height_mm: r.get(9)?,
        paper_size: r.get(10)?,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_list_printers(
    state: State<'_, AppState>,
    use_case: Option<String>,
) -> AppResult<Vec<Printer>> {
    ipc_auth::authorize("cmd_list_printers", state.inner())?;
    let user = current_user()?;
    require_role(&user, &[Role::Owner, Role::Cashier, Role::Stocker])?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    db.with_raw(|c| {
        let (sql, filter): (&str, Option<&str>) = match use_case.as_deref() {
            Some(uc) => (
                &format!(
                    "{SELECT_PRINTER} WHERE p.use_case = ?1 ORDER BY p.is_default DESC, p.name"
                ),
                Some(uc),
            ),
            None => (
                &format!("{SELECT_PRINTER} ORDER BY p.is_default DESC, p.name"),
                None,
            ),
        };
        let mut stmt = c.prepare(sql)?;
        let rows = match filter {
            Some(uc) => stmt.query_map(params![uc], row_to_printer)?,
            None => stmt.query_map([], row_to_printer)?,
        };
        let v = rows.collect::<Result<Vec<_>, _>>()?;
        Ok(v)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_create_printer(state: State<'_, AppState>, input: NewPrinter) -> AppResult<Printer> {
    ipc_auth::authorize("cmd_create_printer", state.inner())?;
    let user = current_user()?;
    require_role(&user, &[Role::Owner])?;
    validate(&input)?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    db.with_tx(|tx| {
        tx.execute(
            "INSERT INTO printers (name, use_case, connection_type, address, driver_name, port_name, is_default, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, (unixepoch('now') * 1000), (unixepoch('now') * 1000))",
            params![
                input.name.trim(),
                input.use_case.to_lowercase(),
                input.connection_type.to_lowercase(),
                input.address,
                input.driver_name,
                input.port_name,
                input.is_default as i64,
            ],
        )?;
        let id = tx.last_insert_rowid();
        match input.use_case.as_str() {
            "label" => {
                tx.execute(
                    "INSERT INTO printer_mappings (printer_id, label_width_mm, label_height_mm, created_at, updated_at) VALUES (?1, ?2, ?3, (unixepoch('now') * 1000), (unixepoch('now') * 1000))",
                    params![id, input.label_width_mm, input.label_height_mm],
                )?;
            }
            "receipt" => {
                let ps = input.paper_size.as_deref().unwrap_or(DEFAULT_RECEIPT_PAPER);
                tx.execute(
                    "INSERT INTO printer_mappings (printer_id, paper_size, created_at, updated_at) VALUES (?1, ?2, (unixepoch('now') * 1000), (unixepoch('now') * 1000))",
                    params![id, ps],
                )?;
            }
            _ => unreachable!(),
        }
        if input.is_default {
            tx.execute(
                "UPDATE printers SET is_default = 0 WHERE use_case = ?1 AND id != ?2",
                params![input.use_case.to_lowercase(), id],
            )?;
        }
        let printer = tx.query_row(
            &format!("{SELECT_PRINTER} WHERE p.id = ?1"),
            params![id],
            row_to_printer,
        )?;
        Ok(printer)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_update_printer(
    state: State<'_, AppState>,
    id: i64,
    input: NewPrinter,
) -> AppResult<Printer> {
    ipc_auth::authorize("cmd_update_printer", state.inner())?;
    let user = current_user()?;
    require_role(&user, &[Role::Owner])?;
    validate(&input)?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    db.with_tx(|tx| {
        let changed = tx.execute(
            "UPDATE printers SET name = ?1, use_case = ?2, connection_type = ?3, address = ?4, driver_name = ?5, port_name = ?6, is_default = ?7, updated_at = (unixepoch('now') * 1000) WHERE id = ?8",
            params![
                input.name.trim(),
                input.use_case.to_lowercase(),
                input.connection_type.to_lowercase(),
                input.address,
                input.driver_name,
                input.port_name,
                input.is_default as i64,
                id,
            ],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound(format!("printer {id} not found")));
        }
        tx.execute(
            "DELETE FROM printer_mappings WHERE printer_id = ?1",
            params![id],
        )?;
        match input.use_case.as_str() {
            "label" => {
                tx.execute(
                    "INSERT INTO printer_mappings (printer_id, label_width_mm, label_height_mm, created_at, updated_at) VALUES (?1, ?2, ?3, (unixepoch('now') * 1000), (unixepoch('now') * 1000))",
                    params![id, input.label_width_mm, input.label_height_mm],
                )?;
            }
            "receipt" => {
                let ps = input.paper_size.as_deref().unwrap_or(DEFAULT_RECEIPT_PAPER);
                tx.execute(
                    "INSERT INTO printer_mappings (printer_id, paper_size, created_at, updated_at) VALUES (?1, ?2, (unixepoch('now') * 1000), (unixepoch('now') * 1000))",
                    params![id, ps],
                )?;
            }
            _ => unreachable!(),
        }
        if input.is_default {
            tx.execute(
                "UPDATE printers SET is_default = 0 WHERE use_case = ?1 AND id != ?2",
                params![input.use_case.to_lowercase(), id],
            )?;
        }
        let printer = tx.query_row(
            &format!("{SELECT_PRINTER} WHERE p.id = ?1"),
            params![id],
            row_to_printer,
        )?;
        Ok(printer)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_delete_printer(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    ipc_auth::authorize("cmd_delete_printer", state.inner())?;
    let user = current_user()?;
    require_role(&user, &[Role::Owner])?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    db.with_tx(|tx| {
        let changed = tx.execute("DELETE FROM printers WHERE id = ?1", params![id])?;
        if changed == 0 {
            return Err(AppError::NotFound(format!("printer {id} not found")));
        }
        Ok(())
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_set_default_printer(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    ipc_auth::authorize("cmd_set_default_printer", state.inner())?;
    let user = current_user()?;
    require_role(&user, &[Role::Owner])?;
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    db.with_tx(|tx| {
        let use_case: Option<String> = tx
            .query_row(
                "SELECT use_case FROM printers WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        let use_case =
            use_case.ok_or_else(|| AppError::NotFound(format!("printer {id} not found")))?;
        tx.execute(
            "UPDATE printers SET is_default = 0 WHERE use_case = ?1 AND id != ?2",
            params![use_case, id],
        )?;
        tx.execute(
            "UPDATE printers SET is_default = 1, updated_at = (unixepoch('now') * 1000) WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_get_default_printer(
    state: State<'_, AppState>,
    use_case: String,
) -> AppResult<Option<Printer>> {
    ipc_auth::authorize("cmd_get_default_printer", state.inner())?;
    let _ = current_user()?;
    let uc = use_case.to_lowercase();
    if !ALLOWED_USE_CASES.contains(&uc.as_str()) {
        return Err(AppError::Validation(format!(
            "use_case must be one of {:?}",
            ALLOWED_USE_CASES
        )));
    }
    let guard = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?;
    let db = guard.as_ref().ok_or(AppError::NotUnlocked)?;
    db.with_raw(|c| {
        let mut stmt = c.prepare(&format!(
            "{SELECT_PRINTER} WHERE p.use_case = ?1 AND p.is_default = 1 ORDER BY p.id LIMIT 1"
        ))?;
        let printer = stmt.query_row(params![uc], row_to_printer).optional()?;
        Ok(printer)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_label_printer_works_without_dimensions() {
        let p = NewPrinter {
            name: "TSC".into(),
            use_case: "label".into(),
            connection_type: "usb".into(),
            address: "USB001".into(),
            driver_name: None,
            port_name: None,
            is_default: false,
            label_width_mm: None,
            label_height_mm: None,
            paper_size: None,
        };
        assert!(validate(&p).is_ok());
    }

    #[test]
    fn validate_label_printer_rejects_paper_size() {
        let p = NewPrinter {
            name: "TSC".into(),
            use_case: "label".into(),
            connection_type: "usb".into(),
            address: "USB001".into(),
            driver_name: None,
            port_name: None,
            is_default: false,
            label_width_mm: None,
            label_height_mm: None,
            paper_size: Some("a4".into()),
        };
        assert!(validate(&p).is_err());
    }

    #[test]
    fn validate_label_printer_rejects_non_positive_dims() {
        let p = NewPrinter {
            name: "TSC".into(),
            use_case: "label".into(),
            connection_type: "usb".into(),
            address: "USB001".into(),
            driver_name: None,
            port_name: None,
            is_default: false,
            label_width_mm: Some(0),
            label_height_mm: Some(25),
            paper_size: None,
        };
        assert!(validate(&p).is_err());
    }

    #[test]
    fn validate_receipt_printer_works_without_paper_size() {
        let p = NewPrinter {
            name: "XP-80".into(),
            use_case: "receipt".into(),
            connection_type: "usb".into(),
            address: "USB002".into(),
            driver_name: None,
            port_name: None,
            is_default: false,
            label_width_mm: None,
            label_height_mm: None,
            paper_size: None,
        };
        assert!(validate(&p).is_ok());
    }

    #[test]
    fn validate_receipt_printer_accepts_known_paper_size() {
        let p = NewPrinter {
            name: "XP-80".into(),
            use_case: "receipt".into(),
            connection_type: "usb".into(),
            address: "USB002".into(),
            driver_name: None,
            port_name: None,
            is_default: false,
            label_width_mm: None,
            label_height_mm: None,
            paper_size: Some("thermal-80mm".into()),
        };
        assert!(validate(&p).is_ok());
    }

    #[test]
    fn validate_receipt_printer_rejects_label_dims() {
        let p = NewPrinter {
            name: "XP-80".into(),
            use_case: "receipt".into(),
            connection_type: "usb".into(),
            address: "USB002".into(),
            driver_name: None,
            port_name: None,
            is_default: false,
            label_width_mm: Some(50),
            label_height_mm: None,
            paper_size: Some("a4".into()),
        };
        assert!(validate(&p).is_err());
    }

    #[test]
    fn validate_receipt_printer_rejects_unknown_paper_size() {
        let p = NewPrinter {
            name: "XP-80".into(),
            use_case: "receipt".into(),
            connection_type: "usb".into(),
            address: "USB002".into(),
            driver_name: None,
            port_name: None,
            is_default: false,
            label_width_mm: None,
            label_height_mm: None,
            paper_size: Some("letter".into()),
        };
        assert!(validate(&p).is_err());
    }

    #[test]
    fn validate_rejects_unknown_use_case() {
        let p = NewPrinter {
            name: "X".into(),
            use_case: "sticker".into(),
            connection_type: "usb".into(),
            address: "".into(),
            driver_name: None,
            port_name: None,
            is_default: false,
            label_width_mm: Some(50),
            label_height_mm: Some(25),
            paper_size: None,
        };
        assert!(validate(&p).is_err());
    }
}

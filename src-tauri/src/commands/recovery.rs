use std::path::PathBuf;

use rusqlite::{params, Connection};
use serde_json;
use tauri::{AppHandle, Manager, State};

use crate::commands::auth::{
    default_lockout_row, now_unix, read_keywrap_from_keystore, validate_owner_pin,
    write_keywrap_to_keystore, write_lockout_to_keystore, AppError, AppState, Session, User,
};
use crate::crypto::kdf::{self, random_dek, random_salt, KdfParams, KEK_LEN};
use crate::crypto::wrap::wrap_dek;
use crate::db;
use crate::db::keywrap::{self, KeywrapRow};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// First-launch setup: create the encrypted database, seed users/settings,
/// wrap the DEK, and store the keywrap metadata.
#[tauri::command]
pub fn first_launch_setup(
    state: State<AppState>,
    app: AppHandle,
    pin: String,
    passphrase: String,
    shop_name: String,
    address: String,
    phone: String,
) -> Result<Session, AppError> {
    // Determine paths.
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
    std::fs::create_dir_all(&app_dir)?;
    let db_path: PathBuf = app_dir.join("paintkiduakan.db");

    // --- Generate crypto material ----------------------------------------
    let dek = random_dek();
    let pin_salt = random_salt();
    let rec_salt = random_salt();
    let backup_salt = random_salt(); // spec §4.1: 16-byte random

    let pin_params = KdfParams::PIN;
    let rec_params = KdfParams::RECOVERY;

    let mut pin_kek = kdf::derive_pin_kek(&pin, &pin_salt, &pin_params)
        .map_err(|e| AppError::Crypto(e.to_string()))?;
    let mut rec_kek = kdf::derive_recovery_k(&passphrase, &rec_salt)
        .map_err(|e| AppError::Crypto(e.to_string()))?;

    let pin_wrapped_dek = wrap_dek(&dek, &pin_kek)
        .map_err(|e| AppError::Crypto(e.to_string()))?;
    let rec_wrapped_dek = wrap_dek(&dek, &rec_kek)
        .map_err(|e| AppError::Crypto(e.to_string()))?;

    // Zeroize intermediate keys.
    kdf::zeroize_key(&mut pin_kek);
    kdf::zeroize_key(&mut rec_kek);

    // --- Open main encrypted DB and apply schema -------------------------
    let db = db::Db::open(&db_path, &dek)?;

    db.with_conn(|conn: &Connection| {
        // Seed owner user (placeholder pin_salt/verifier — per-user PIN is post-v1).
        conn.execute(
            "INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length) \
             VALUES (?1, 'owner', ?2, ?3, 6)",
            params!["Owner", &[0u8; 16] as &[u8], &[0u8; KEK_LEN] as &[u8]],
        )?;

        // Seed settings.
        conn.execute(
            "INSERT INTO settings (id, shop_name, address, phone) \
             VALUES (1, ?1, ?2, ?3)",
            params![shop_name, address, phone],
        )?;

        // Seed default locations expected by inward/POS workflows.
        conn.execute("INSERT INTO locations (name) VALUES ('Shop'), ('Godown')", [])?;

        Ok::<_, rusqlite::Error>(())
    })?;

    // --- Write keywrap to keystore (separate, unencrypted) ---------------
    let ts = now_unix() as i64;
    let row = KeywrapRow {
        id: 1,
        pin_salt: pin_salt.to_vec(),
        pin_params: serde_json::to_vec(&pin_params).unwrap(),
        pin_wrapped_dek,
        rec_salt: rec_salt.to_vec(),
        rec_params: serde_json::to_vec(&rec_params).unwrap(),
        rec_wrapped_dek,
        backup_salt: backup_salt.to_vec(),
        version: 1,
        created_at: ts,
        updated_at: ts,
    };
    write_keywrap_to_keystore(&db_path, &row)?;

    // Seed the sidecar lockout policy row with spec defaults.
    write_lockout_to_keystore(&db_path, &default_lockout_row())?;

    // --- Set state -------------------------------------------------------
    *state.db_path.lock().unwrap() = Some(db_path);
    *state.db.lock().unwrap() = Some(db);

    let user = User {
        id: 1,
        name: "Owner".into(),
        role: "owner".into(),
        is_active: true,
    };
    *state.session.lock().unwrap() = Some(user.clone());

    state
        .last_activity
        .store(now_unix(), std::sync::atomic::Ordering::SeqCst);

    Ok(Session {
        user: Some(user),
        locked: false,
    })
}

/// Change the recovery passphrase (owner-only).
#[tauri::command]
pub fn set_recovery_passphrase(
    state: State<AppState>,
    current_pin: String,
    new_passphrase: String,
) -> Result<(), AppError> {
    let session = state.session.lock().unwrap();
    let session = session.as_ref().ok_or(AppError::NotUnlocked)?;
    if session.role != "owner" {
        return Err(AppError::Unauthorized);
    }

    let db_path = state.db_path.lock().unwrap().clone().ok_or(AppError::NoDb)?;
    let db = state.db.lock().unwrap();
    let db = db.as_ref().ok_or(AppError::NotUnlocked)?;
    let dek = db.dek();

    // Verify current PIN.
    let mut row = read_keywrap_from_keystore(&db_path)?;
    let _ = keywrap::unwrap_with_pin(&row, &current_pin)?;

    // Rewrap recovery with new passphrase.
    keywrap::rewrap_recovery(&mut row, dek, &new_passphrase)?;
    write_keywrap_to_keystore(&db_path, &row)?;

    Ok(())
}

/// Restore access using the recovery passphrase, then set a new PIN.
#[tauri::command]
pub fn restore_from_recovery(
    state: State<AppState>,
    app: AppHandle,
    passphrase: String,
    new_pin: String,
) -> Result<Session, AppError> {
    validate_owner_pin(&new_pin)?;

    let db_path = match state.db_path.lock().unwrap().clone() {
        Some(p) => p,
        None => {
            let app_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
            app_dir.join("paintkiduakan.db")
        }
    };

    // Read keywrap, unwrap with recovery.
    let mut row = read_keywrap_from_keystore(&db_path)?;
    let dek = keywrap::unwrap_with_recovery(&row, &passphrase)?;

    // Rewrap with the new PIN.
    keywrap::rewrap_pin(&mut row, &dek, &new_pin)?;
    write_keywrap_to_keystore(&db_path, &row)?;

    // Open the main DB.
    let db = db::Db::open(&db_path, &dek)?;
    *state.db_path.lock().unwrap() = Some(db_path.clone());

    let user = db.with_conn(|conn: &Connection| {
        let mut stmt = conn
            .prepare("SELECT id, name, role FROM users WHERE role = 'owner' AND active = 1 LIMIT 1")?;
        stmt.query_row([], |r| {
            Ok(User {
                id: r.get(0)?,
                name: r.get(1)?,
                role: r.get(2)?,
                is_active: true,
            })
        })
    })?;

    *state.db.lock().unwrap() = Some(db);
    *state.session.lock().unwrap() = Some(user.clone());
    *state.failed_attempts.lock().unwrap() = 0;
    state
        .last_activity
        .store(now_unix(), std::sync::atomic::Ordering::SeqCst);

    Ok(Session {
        user: Some(user),
        locked: false,
    })
}

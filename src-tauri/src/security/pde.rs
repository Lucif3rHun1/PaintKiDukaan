use std::path::Path;

use rusqlite::params;
use serde::Serialize;
use tauri::State;

use crate::commands::auth::AppState;
use crate::crypto::kdf::{self, random_dek, random_salt, KdfParams};
use crate::crypto::wrap::wrap_dek;
use crate::db;
use crate::db::keywrap::{self, KeywrapRow, PinRole};
use crate::error::AppError;
use crate::obs;
use crate::security::ipc_auth;

/// Provision a decoy DB with plausible fake data and set up decoy + duress
/// keywrap rows. Both decoy and duress share the same DEK_decoy so a single
/// decoy DB serves both unlock paths.
///
/// Called from frontend wizard (Track F handles UI).
pub fn provision_decoy_db_impl(
    db_path: &Path,
    decoy_pin: &str,
    duress_pin: &str,
    fake_shop_name: &str,
) -> Result<(), AppError> {
    let decoy_db_path = decoy_db_path(db_path);
    let keystore_path = db_path.with_extension("keystore");

    let dek_decoy = random_dek();

    {
        let decoy_db = db::Db::open(&decoy_db_path, &dek_decoy)
            .map_err(|e| AppError::Crypto(format!("decoy DB open: {e}")))?;

        decoy_db.with_conn(|conn: &rusqlite::Connection| {
            let now = crate::commands::auth::now_unix() as i64;
            conn.execute(
                "INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length, created_at, updated_at) \
                 VALUES (?1, 'owner', ?2, ?3, 6, ?4, ?4)",
                params![fake_shop_name, &[0u8; 32] as &[u8], &[0u8; 32] as &[u8], now],
            )?;
            conn.execute("INSERT INTO settings (id, shop_name, address, phone, created_at, updated_at) VALUES (1, ?1, '', '', ?2, ?2)",
                params![fake_shop_name, now],
            )?;
            conn.execute("INSERT INTO locations (name, is_active, created_at, updated_at) VALUES ('Main Shop', 1, ?1, ?1)",
                params![now],
            )?;
            conn.execute(
                "INSERT INTO items (sku_code, name, unit_id, unit_code, unit_label, retail_price_paise, cost_paise, primary_location_id, created_at, updated_at) \
                 VALUES ('SP001', 'Sample Paint 1L', 1, 'L', 'Litre', 50000, 35000, 1, ?1, ?1)",
                params![now],
            )?;
            conn.execute(
                "INSERT INTO items (sku_code, name, unit_id, unit_code, unit_label, retail_price_paise, cost_paise, primary_location_id, created_at, updated_at) \
                 VALUES ('PR004', 'Primer 4L', 1, 'L', 'Litre', 120000, 80000, 1, ?1, ?1)",
                params![now],
            )?;
            Ok::<_, rusqlite::Error>(())
        })?;
    }

    let conn = crate::commands::auth::open_keystore(&keystore_path)?;

    let ts = crate::commands::auth::now_unix() as i64;
    let pin_params_json = serde_json::to_vec(&KdfParams::PIN)
        .map_err(|e| AppError::Crypto(format!("pin_params: {e}")))?;
    let rec_params_json = serde_json::to_vec(&KdfParams::RECOVERY)
        .map_err(|e| AppError::Crypto(format!("rec_params: {e}")))?;

    for (id, role, pin) in [
        (2, PinRole::Decoy, decoy_pin),
        (3, PinRole::Duress, duress_pin),
    ] {
        let pin_salt = random_salt();
        let rec_salt = random_salt();
        let backup_salt = random_salt();

        let mut pin_kek = kdf::derive_pin_kek(pin, &pin_salt, &KdfParams::PIN)
            .map_err(|e| AppError::Crypto(e.to_string()))?;
        let pin_wrapped_dek =
            wrap_dek(&dek_decoy, &pin_kek).map_err(|e| AppError::Crypto(e.to_string()))?;
        let verifier = keywrap::pin_verifier_for_kek(&pin_kek).to_vec();
        kdf::zeroize_key(&mut pin_kek);

        let mut rec_kek = kdf::derive_pin_kek("", &rec_salt, &KdfParams::RECOVERY)
            .map_err(|e| AppError::Crypto(e.to_string()))?;
        let rec_wrapped_dek =
            wrap_dek(&dek_decoy, &rec_kek).map_err(|e| AppError::Crypto(e.to_string()))?;
        kdf::zeroize_key(&mut rec_kek);

        let row = KeywrapRow {
            id,
            role,
            pin_salt: pin_salt.to_vec(),
            pin_params: pin_params_json.clone(),
            pin_wrapped_dek,
            pin_verifier: verifier,
            rec_salt: rec_salt.to_vec(),
            rec_params: rec_params_json.clone(),
            rec_wrapped_dek,
            backup_salt: backup_salt.to_vec(),
            version: 1,
            created_at: ts,
            updated_at: ts,
        };
        keywrap::upsert(&conn, &row).map_err(AppError::Db)?;
    }

    conn.close()?;
    Ok(())
}

/// Migrate a single-keywrap (pre-PDE) installation to PDE by generating
/// decoy + duress rows with random PINs. The user should set their own
/// decoy/duress PINs via settings after upgrade.
pub fn migrate_single_to_pde(db_path: &Path) -> Result<(), AppError> {
    let keystore_path = db_path.with_extension("keystore");
    let conn = crate::commands::auth::open_keystore(&keystore_path)?;

    let existing = keywrap::read_all(&conn)?;
    if existing
        .iter()
        .any(|r| r.role == PinRole::Decoy || r.role == PinRole::Duress)
    {
        return Ok(());
    }

    let dek_decoy = random_dek();
    let ts = crate::commands::auth::now_unix() as i64;
    let pin_params_json = serde_json::to_vec(&KdfParams::PIN)
        .map_err(|e| AppError::Crypto(format!("pin_params: {e}")))?;
    let rec_params_json = serde_json::to_vec(&KdfParams::RECOVERY)
        .map_err(|e| AppError::Crypto(format!("rec_params: {e}")))?;

    for (id, role) in [(2, PinRole::Decoy), (3, PinRole::Duress)] {
        let random_pin = format!("{:06}", rand::random::<u32>() % 1_000_000);
        let pin_salt = random_salt();
        let rec_salt = random_salt();
        let backup_salt = random_salt();

        let mut pin_kek = kdf::derive_pin_kek(&random_pin, &pin_salt, &KdfParams::PIN)
            .map_err(|e| AppError::Crypto(e.to_string()))?;
        let pin_wrapped_dek =
            wrap_dek(&dek_decoy, &pin_kek).map_err(|e| AppError::Crypto(e.to_string()))?;
        let verifier = keywrap::pin_verifier_for_kek(&pin_kek).to_vec();
        kdf::zeroize_key(&mut pin_kek);

        let mut rec_kek = kdf::derive_pin_kek("", &rec_salt, &KdfParams::RECOVERY)
            .map_err(|e| AppError::Crypto(e.to_string()))?;
        let rec_wrapped_dek =
            wrap_dek(&dek_decoy, &rec_kek).map_err(|e| AppError::Crypto(e.to_string()))?;
        kdf::zeroize_key(&mut rec_kek);

        let row = KeywrapRow {
            id,
            role,
            pin_salt: pin_salt.to_vec(),
            pin_params: pin_params_json.clone(),
            pin_wrapped_dek,
            pin_verifier: verifier,
            rec_salt: rec_salt.to_vec(),
            rec_params: rec_params_json.clone(),
            rec_wrapped_dek,
            backup_salt: backup_salt.to_vec(),
            version: 1,
            created_at: ts,
            updated_at: ts,
        };
        keywrap::upsert(&conn, &row).map_err(AppError::Db)?;
    }

    conn.close()?;
    Ok(())
}

/// Compute the decoy DB path: `paintkiduakan.decoy.db` next to the real DB.
pub fn decoy_db_path(real_db_path: &Path) -> std::path::PathBuf {
    real_db_path
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join(obs!("paintkiduakan.decoy.db"))
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// PDE status returned to the frontend.
#[derive(Serialize)]
pub struct PdeStatus {
    pub enabled: bool,
    pub has_decoy: bool,
    pub has_duress: bool,
}

/// Get the current PDE status by checking if decoy/duress keywrap rows exist
/// in the keystore sidecar.
#[tauri::command(rename_all = "snake_case")]
pub fn get_pde_status(state: State<'_, AppState>) -> Result<PdeStatus, AppError> {
    ipc_auth::authorize("get_pde_status", state.inner())?;
    let db_path = state
        .db_path
        .lock()
        .unwrap()
        .clone()
        .ok_or(AppError::NoDb)?;
    let keystore_path = db_path.with_extension("keystore");
    let conn = crate::commands::auth::open_keystore(&keystore_path)?;
    let rows = keywrap::read_all(&conn)?;

    let has_decoy = rows.iter().any(|r| r.role == PinRole::Decoy);
    let has_duress = rows.iter().any(|r| r.role == PinRole::Duress);

    Ok(PdeStatus {
        enabled: has_decoy && has_duress,
        has_decoy,
        has_duress,
    })
}

/// Provision a decoy database with plausible fake data (Tauri command wrapper).
#[tauri::command(rename_all = "snake_case")]
pub fn provision_decoy_db(
    state: State<'_, AppState>,
    decoy_pin: String,
    duress_pin: String,
    fake_shop_name: String,
) -> Result<(), AppError> {
    ipc_auth::authorize("provision_decoy_db", state.inner())?;
    let db_path = state
        .db_path
        .lock()
        .unwrap()
        .clone()
        .ok_or(AppError::NoDb)?;
    provision_decoy_db_impl(&db_path, &decoy_pin, &duress_pin, &fake_shop_name)
}

/// Change the decoy PIN. The owner must authenticate with their real PIN.
/// The decoy DEK is recovered via the recovery path (empty passphrase) and
/// re-wrapped with the new decoy PIN.
#[tauri::command(rename_all = "snake_case")]
pub fn change_decoy_pin(
    state: State<'_, AppState>,
    current_real_pin: String,
    new_decoy_pin: String,
) -> Result<(), AppError> {
    ipc_auth::authorize("change_decoy_pin", state.inner())?;
    let db_path = state
        .db_path
        .lock()
        .unwrap()
        .clone()
        .ok_or(AppError::NoDb)?;
    let keystore_path = db_path.with_extension("keystore");
    let conn = crate::commands::auth::open_keystore(&keystore_path)?;

    let real_row = keywrap::read_by_role(&conn, PinRole::Real)?;
    let _ = keywrap::unwrap_with_pin(&real_row, &current_real_pin)?;

    let mut decoy_row = keywrap::read_by_role(&conn, PinRole::Decoy)?;
    let dek_decoy = keywrap::unwrap_with_recovery(&decoy_row, "")?;

    keywrap::rewrap_pin(&mut decoy_row, &dek_decoy, &new_decoy_pin)?;
    keywrap::upsert(&conn, &decoy_row)?;
    conn.close()?;

    Ok(())
}

/// Change the duress PIN. The owner must authenticate with their real PIN.
/// The duress DEK is recovered via the recovery path (empty passphrase) and
/// re-wrapped with the new duress PIN.
#[tauri::command(rename_all = "snake_case")]
pub fn change_duress_pin(
    state: State<'_, AppState>,
    current_real_pin: String,
    new_duress_pin: String,
) -> Result<(), AppError> {
    ipc_auth::authorize("change_duress_pin", state.inner())?;
    let db_path = state
        .db_path
        .lock()
        .unwrap()
        .clone()
        .ok_or(AppError::NoDb)?;
    let keystore_path = db_path.with_extension("keystore");
    let conn = crate::commands::auth::open_keystore(&keystore_path)?;

    let real_row = keywrap::read_by_role(&conn, PinRole::Real)?;
    let _ = keywrap::unwrap_with_pin(&real_row, &current_real_pin)?;

    let mut duress_row = keywrap::read_by_role(&conn, PinRole::Duress)?;
    let dek_duress = keywrap::unwrap_with_recovery(&duress_row, "")?;

    keywrap::rewrap_pin(&mut duress_row, &dek_duress, &new_duress_pin)?;
    keywrap::upsert(&conn, &duress_row)?;
    conn.close()?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::keywrap::{PinRole, KEYSTORE_SCHEMA};

    #[test]
    fn decoy_db_path_is_sibling() {
        let real = std::path::PathBuf::from("/data/paintkiduakan.db");
        let decoy = decoy_db_path(&real);
        assert_eq!(
            decoy,
            std::path::PathBuf::from("/data/paintkiduakan.decoy.db")
        );
    }

    #[test]
    fn provision_decoy_db_creates_rows() {
        let dir = tempfile::tempdir().unwrap();
        let real_db = dir.path().join("paintkiduakan.db");
        let keystore = real_db.with_extension("keystore");

        let conn = rusqlite::Connection::open(&keystore).unwrap();
        conn.execute_batch(KEYSTORE_SCHEMA).unwrap();

        let dek_real = random_dek();
        let pin_salt = random_salt().to_vec();
        let rec_salt = random_salt().to_vec();
        let backup_salt = random_salt().to_vec();
        let pin_params = serde_json::to_vec(&KdfParams::PIN).unwrap();
        let rec_params = serde_json::to_vec(&KdfParams::RECOVERY).unwrap();

        let mut pin_kek = kdf::derive_pin_kek("123456", &pin_salt, &KdfParams::PIN).unwrap();
        let verifier = keywrap::pin_verifier_for_kek(&pin_kek).to_vec();
        let pin_wrapped = wrap_dek(&dek_real, &pin_kek).unwrap();
        kdf::zeroize_key(&mut pin_kek);

        let row = KeywrapRow {
            id: 1,
            role: PinRole::Real,
            pin_salt: pin_salt.clone(),
            pin_params: pin_params.clone(),
            pin_wrapped_dek: pin_wrapped,
            pin_verifier: verifier,
            rec_salt: rec_salt.clone(),
            rec_params: rec_params.clone(),
            rec_wrapped_dek: vec![],
            backup_salt: backup_salt.clone(),
            version: 1,
            created_at: 1000,
            updated_at: 1000,
        };
        keywrap::upsert(&conn, &row).unwrap();
        drop(conn);

        provision_decoy_db_impl(&real_db, "222222", "333333", "Fake Shop").unwrap();

        let conn = crate::commands::auth::open_keystore(&keystore).unwrap();
        let all = keywrap::read_all(&conn).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].role, PinRole::Real);
        assert_eq!(all[1].role, PinRole::Decoy);
        assert_eq!(all[2].role, PinRole::Duress);

        let decoy_path = decoy_db_path(&real_db);
        assert!(decoy_path.exists(), "decoy DB file must exist");
    }

    #[test]
    fn migrate_single_to_pde_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let real_db = dir.path().join("paintkiduakan.db");
        let keystore = real_db.with_extension("keystore");

        let conn = rusqlite::Connection::open(&keystore).unwrap();
        conn.execute_batch(KEYSTORE_SCHEMA).unwrap();

        let dek = random_dek();
        let pin_salt = random_salt().to_vec();
        let pin_params = serde_json::to_vec(&KdfParams::PIN).unwrap();
        let mut pin_kek = kdf::derive_pin_kek("123456", &pin_salt, &KdfParams::PIN).unwrap();
        let verifier = keywrap::pin_verifier_for_kek(&pin_kek).to_vec();
        let wrapped = wrap_dek(&dek, &pin_kek).unwrap();
        kdf::zeroize_key(&mut pin_kek);

        let row = KeywrapRow {
            id: 1,
            role: PinRole::Real,
            pin_salt,
            pin_params,
            pin_wrapped_dek: wrapped,
            pin_verifier: verifier,
            rec_salt: vec![],
            rec_params: vec![],
            rec_wrapped_dek: vec![],
            backup_salt: vec![],
            version: 1,
            created_at: 1000,
            updated_at: 1000,
        };
        keywrap::upsert(&conn, &row).unwrap();
        drop(conn);

        migrate_single_to_pde(&real_db).unwrap();
        migrate_single_to_pde(&real_db).unwrap();

        let conn = crate::commands::auth::open_keystore(&keystore).unwrap();
        let all = keywrap::read_all(&conn).unwrap();
        assert_eq!(all.len(), 3);
    }
}

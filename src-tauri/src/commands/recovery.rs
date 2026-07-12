use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde_json;
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroizing;

use crate::commands::auth::{
    default_lockout_row, now_unix, read_keywrap_from_keystore, sync_session_to_static,
    validate_owner_pin, write_keywrap_to_keystore, write_lockout_to_keystore, AppState, Session,
    User,
};
use crate::crypto::kdf::{self, random_dek, random_salt, KdfParams, KEK_LEN};
use crate::crypto::wrap::wrap_dek;
use crate::db;
use crate::db::keywrap::{self, KeywrapRow, PinRole};
use crate::error::AppError;
use crate::security::ipc_auth;

/// Wipe any leftover database files and sidecar before first-launch setup.
pub(crate) fn wipe_existing_setup(db_path: &Path) -> std::io::Result<()> {
    let mut to_remove: Vec<PathBuf> = vec![
        db_path.to_path_buf(),
        db_path.with_extension("db-wal"),
        db_path.with_extension("db-shm"),
        db_path.with_extension("keystore"),
        // ponytail: decoy DB lives next to the real one
        db_path.parent().unwrap_or(db_path).join(crate::obs!("pkb_cache_v2.db")),
    ];
    // de-duplicate in case with_extension collapsed to the same path
    to_remove.sort();
    to_remove.dedup();

    for path in to_remove {
        match std::fs::remove_file(&path) {
            Ok(()) => log::debug!("wiped {}", path.display()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                log::debug!("nothing to wipe at {}", path.display())
            }
            Err(e) => {
                log::error!("failed to wipe {}: {e}", path.display());
                return Err(e);
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Core first-launch setup logic, parameterized by the database path so it
/// can be exercised in tests without a Tauri `AppHandle`.
pub(crate) fn first_launch_setup_at_path(
    state: &AppState,
    db_path: &Path,
    pin: String,
    passphrase: String,
    shop_name: String,
    address: String,
    phone: String,
    gstin: Option<String>,
) -> Result<Session, AppError> {
    log::info!("[SETUP] first_launch_setup_at_path called");
    // ponytail: frontend enforces 12 chars, backend must too
    if passphrase.len() < 12 {
        return Err(AppError::Validation("recovery passphrase must be at least 12 characters".into()));
    }
    log::info!(
        "[SETUP] pin len={}, passphrase len={}, shop={}",
        pin.len(),
        passphrase.len(),
        shop_name
    );
    log::info!("[SETUP] DB path: {:?}", db_path);

    // --- Wipe any leftover DB + sidecar from a previous attempt -----------
    wipe_existing_setup(db_path)?;

    // --- Generate crypto material ----------------------------------------
    log::info!("[SETUP] Generating crypto material...");
    let dek = random_dek();
    let pin_salt = random_salt();
    let rec_salt = random_salt();
    let backup_salt = random_salt();
    log::info!("[SETUP] Crypto salts generated");

    let pin_params = KdfParams::PIN;
    let rec_params = KdfParams::RECOVERY;

    log::info!("[SETUP] Deriving PIN KEK (Argon2id 256 MiB)...");
    let mut pin_kek = kdf::derive_pin_kek(&pin, &pin_salt, &pin_params)
        .map_err(|e| AppError::Crypto(e.to_string()))?;
    log::info!("[SETUP] PIN KEK derived OK");
    log::info!("[SETUP] Deriving recovery KEK (Argon2id 256 MiB)...");
    let mut rec_kek = kdf::derive_recovery_k(&passphrase, &rec_salt)
        .map_err(|e| AppError::Crypto(e.to_string()))?;
    log::info!("[SETUP] Recovery KEK derived OK");

    log::info!("[SETUP] Wrapping DEK with PIN KEK...");
    let pin_wrapped_dek = wrap_dek(&dek, &pin_kek).map_err(|e| AppError::Crypto(e.to_string()))?;
    log::info!("[SETUP] Wrapping DEK with recovery KEK...");
    let rec_wrapped_dek = wrap_dek(&dek, &rec_kek).map_err(|e| AppError::Crypto(e.to_string()))?;
    log::info!("[SETUP] DEK wrapped OK");

    kdf::zeroize_key(&mut pin_kek);
    kdf::zeroize_key(&mut rec_kek);

    // --- Open main encrypted DB and apply schema -------------------------
    log::info!("[SETUP] Opening encrypted DB...");
    let db = db::Db::open(db_path, &dek)?;
    log::info!("[SETUP] DB opened OK, seeding data...");

    let ts = (now_unix() as i64) * 1000;
    db.with_conn(|conn: &Connection| {
        conn.execute(
            "INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length, created_at, updated_at) \
             VALUES (?1, 'owner', ?2, ?3, 6, ?4, ?5)",
            params!["Owner", &[0u8; 16] as &[u8], &[0u8; KEK_LEN] as &[u8], ts, ts],
        )?;

        conn.execute(
            "INSERT OR REPLACE INTO settings (id, shop_name, address, phone, gstin, created_at, updated_at) \
             VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)",
            params![shop_name, address, phone, gstin, ts, ts],
        )?;

        conn.execute(
            "INSERT INTO locations (name, zone, is_default, is_active, created_at, updated_at) \
             VALUES ('Shop', NULL, 1, 1, ?1, ?2), ('Godown', NULL, 0, 1, ?1, ?2)",
            params![ts, ts],
        )?;

        Ok::<_, rusqlite::Error>(())
    })?;
    log::info!("[SETUP] Data seeded OK");

    // --- Write keywrap to keystore (separate, unencrypted) ---------------
    log::info!("[SETUP] Writing keywrap to keystore sidecar...");
    let ts = now_unix() as i64;
    let pin_params_json = serde_json::to_vec(&pin_params)
        .map_err(|e| AppError::Crypto(format!("pin_params serialize: {e}")))?;
    let rec_params_json = serde_json::to_vec(&rec_params)
        .map_err(|e| AppError::Crypto(format!("rec_params serialize: {e}")))?;

    let mut pin_kek_for_verifier = kdf::derive_pin_kek(&pin, &pin_salt, &pin_params)
        .map_err(|e| AppError::Crypto(e.to_string()))?;
    let verifier = keywrap::pin_verifier_for_kek(&pin_kek_for_verifier).to_vec();
    kdf::zeroize_key(&mut pin_kek_for_verifier);

    let row = KeywrapRow {
        id: 1,
        role: PinRole::Real,
        pin_salt: pin_salt.to_vec(),
        pin_params: pin_params_json,
        pin_wrapped_dek,
        pin_verifier: verifier,
        rec_salt: rec_salt.to_vec(),
        rec_params: rec_params_json,
        rec_wrapped_dek,
        backup_salt: backup_salt.to_vec(),
        version: 1,
        created_at: ts,
        updated_at: ts,
    };
    write_keywrap_to_keystore(db_path, &row)?;
    log::info!("[SETUP] Keywrap written OK");

    // Seed the sidecar lockout policy row with spec defaults.
    log::info!("[SETUP] Writing lockout row...");
    write_lockout_to_keystore(db_path, &default_lockout_row())?;
    log::info!("[SETUP] Lockout row written OK");

    // --- Set state -------------------------------------------------------
    log::info!("[SETUP] Setting app state...");
    *state.db_path.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = Some(db_path.to_path_buf());
    *state.db.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = Some(db);

    let user = User {
        id: 1,
        name: "Owner".into(),
        role: "owner".into(),
        is_active: true,
    };
    *state.session.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = Some(user.clone());
    sync_session_to_static(state);
    *state.recovery_passphrase.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = Some(Zeroizing::new(passphrase));

    state
        .last_activity
        .store(now_unix(), std::sync::atomic::Ordering::SeqCst);

    Ok(Session {
        user: Some(user),
        locked: false,
    })
}

/// First-launch setup: create the encrypted database, seed users/settings,
/// wrap the DEK, and store the keywrap metadata.
/// If decoy_pin + duress_pin + fake_shop_name are all provided, provisions a
/// decoy DB with plausible fake data (PDE feature).
#[tauri::command(rename_all = "snake_case")]
pub fn first_launch_setup<R: tauri::Runtime>(
    state: State<AppState>,
    app: AppHandle<R>,
    pin: String,
    passphrase: String,
    shop_name: String,
    address: String,
    phone: String,
    gstin: Option<String>,
    decoy_pin: Option<String>,
    duress_pin: Option<String>,
    fake_shop_name: Option<String>,
) -> Result<Session, AppError> {
    log::info!("[SETUP] first_launch_setup called");
    log::info!("[SETUP] Resolving app data dir...");
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
    log::info!("[SETUP] App dir: {:?}", app_dir);
    std::fs::create_dir_all(&app_dir)?;
    let db_path: PathBuf = app_dir.join(crate::security::app_paths::db_name());

    let session =
        first_launch_setup_at_path(&state, &db_path, pin, passphrase, shop_name, address, phone, gstin)?;

    if let (Some(dp), Some(dup), Some(fs)) = (decoy_pin, duress_pin, fake_shop_name) {
        log::info!("[SETUP] Provisioning decoy DB (PDE)...");
        crate::security::pde::provision_decoy_db_impl(&db_path, &dp, &dup, &fs)?;
    }

    Ok(session)
}

/// Change the recovery passphrase (owner-only).
#[tauri::command(rename_all = "snake_case")]
pub fn set_recovery_passphrase(
    state: State<AppState>,
    current_pin: String,
    new_passphrase: String,
) -> Result<(), AppError> {
    ipc_auth::authorize("set_recovery_passphrase", state.inner())?;

    // ponytail: frontend enforces 12 chars, backend must too
    if new_passphrase.len() < 12 {
        return Err(AppError::Validation("recovery passphrase must be at least 12 characters".into()));
    }

    let db_path = state
        .db_path
        .lock()
        .unwrap()
        .clone()
        .ok_or(AppError::NoDb)?;
    let db = state.db.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))?;
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
#[tauri::command(rename_all = "snake_case")]
pub fn restore_from_recovery(
    state: State<AppState>,
    app: AppHandle,
    passphrase: String,
    new_pin: String,
) -> Result<Session, AppError> {
    validate_owner_pin(&new_pin)?;

    let db_path = match state.db_path.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))?.clone() {
        Some(p) => p,
        None => {
            let app_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
            app_dir.join(crate::security::app_paths::db_name())
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
    *state.db_path.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = Some(db_path.clone());

    let user = db.with_conn(|conn: &Connection| {
        let mut stmt = conn.prepare(
            "SELECT id, name, role FROM users WHERE role = 'owner' AND is_active = 1 LIMIT 1",
        )?;
        stmt.query_row([], |r| {
            Ok(User {
                id: r.get(0)?,
                name: r.get(1)?,
                role: r.get(2)?,
                is_active: true,
            })
        })
    })?;

    *state.db.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = Some(db);
    *state.session.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = Some(user.clone());
    sync_session_to_static(&state);
    *state.failed_attempts.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = 0;
    state
        .last_activity
        .store(now_unix(), std::sync::atomic::Ordering::SeqCst);

    Ok(Session {
        user: Some(user),
        locked: false,
    })
}

#[tauri::command]
pub async fn cmd_pick_backup_file(state: State<'_, AppState>) -> Result<Option<String>, AppError> {
    ipc_auth::authorize_err("cmd_pick_backup_file", state.inner())?;
    let file = rfd::FileDialog::new()
        .add_filter("PaintKiDukaan Backup", &["pkb1"])
        .pick_file();
    Ok(file.map(|p| p.to_string_lossy().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::kdf::KdfParams;
    use crate::db::Db;
    use std::env;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn unique_test_dir(label: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = env::temp_dir().join(format!(
            "paintkiduakan-test-{label}-{ts}-{}-{pid}",
            n,
            pid = std::process::id(),
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn wipe_existing_setup_no_files_is_noop() {
        let dir = unique_test_dir("wipe-empty");
        let db_path = dir.join("paintkiduakan.db");
        assert!(!db_path.exists(), "precondition: no db file");

        wipe_existing_setup(&db_path).expect("wipe on empty dir should succeed");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn wipe_existing_setup_removes_stale_files() {
        let dir = unique_test_dir("wipe-stale");
        let db_path = dir.join("paintkiduakan.db");

        std::fs::write(&db_path, b"stale db bytes").unwrap();
        let wal = db_path.with_extension("db-wal");
        let shm = db_path.with_extension("db-shm");
        let keystore = db_path.with_extension("keystore");
        std::fs::write(&wal, b"wal bytes").unwrap();
        std::fs::write(&shm, b"shm bytes").unwrap();
        std::fs::write(&keystore, b"keystore bytes").unwrap();

        assert!(db_path.exists());
        assert!(wal.exists());
        assert!(shm.exists());
        assert!(keystore.exists());

        wipe_existing_setup(&db_path).expect("wipe should succeed");

        assert!(!db_path.exists(), "db file should be removed");
        assert!(!wal.exists(), "wal file should be removed");
        assert!(!shm.exists(), "shm file should be removed");
        assert!(!keystore.exists(), "keystore file should be removed");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn wipe_existing_setup_partial_stale() {
        let dir = unique_test_dir("wipe-partial");
        let db_path = dir.join("paintkiduakan.db");

        std::fs::write(&db_path, b"db").unwrap();
        std::fs::write(&db_path.with_extension("keystore"), b"ks").unwrap();

        wipe_existing_setup(&db_path).expect("partial wipe should succeed");
        assert!(!db_path.exists());
        assert!(!db_path.with_extension("keystore").exists());

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Mirrors the pre-Db::open slice of `first_launch_setup` without an
    /// `AppHandle` — uses a real file path so any file-based cipher quirks
    /// surface here. Also writes and reads back the keywrap sidecar to catch
    /// the empty-keystore regression.
    #[test]
    fn pre_db_open_flow_with_prod_cipher() {
        use crate::crypto::kdf::{derive_pin_kek, random_dek, random_salt, KdfParams, KEK_LEN};
        use crate::crypto::wrap::wrap_dek;
        use crate::db::keywrap::{pin_verifier_for_kek, KeywrapRow, PinRole};

        let dir = unique_test_dir("pre-open");
        let db_path = dir.join("paintkiduakan.db");

        wipe_existing_setup(&db_path).expect("initial wipe");

        std::fs::write(&db_path, b"stale").unwrap();
        wipe_existing_setup(&db_path).expect("retry wipe");

        let dek = random_dek();
        let db = Db::open(&db_path, &dek).expect("Db::open with real file + prod cipher");

        let ts = (now_unix() as i64) * 1000;
        db.with_conn::<_, _, rusqlite::Error>(|conn| {
            conn.execute(
                "INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length, created_at, updated_at) \
                 VALUES (?1, 'owner', ?2, ?3, 6, ?4, ?5)",
                params!["Owner", &[0u8; 16][..], &[0u8; KEK_LEN][..], ts, ts],
            )?;
            conn.execute(
                "INSERT OR REPLACE INTO settings (id, shop_name, address, phone, created_at, updated_at) \
                 VALUES (1, ?1, ?2, ?3, ?4, ?5)",
                params!["Test Shop", "123 Test St", "555-0100", ts, ts],
            )?;
            conn.execute(
                "INSERT INTO locations (name, zone, is_default, is_active, created_at, updated_at) \
                 VALUES (?1, NULL, 1, 1, ?3, ?4), (?2, NULL, 0, 1, ?3, ?4)",
                params!["Shop", "Godown", ts, ts],
            )?;
            Ok(())
        })
        .expect("INSERTs in pre_open flow");

        let pin = "123456";
        let passphrase = "correct horse battery staple";
        let pin_salt = random_salt();
        let rec_salt = random_salt();
        let backup_salt = random_salt();
        let pin_params = KdfParams::PIN;
        let rec_params = KdfParams::RECOVERY;

        let mut pin_kek = derive_pin_kek(pin, &pin_salt, &pin_params).unwrap();
        let mut rec_kek = derive_pin_kek(passphrase, &rec_salt, &rec_params).unwrap();
        let pin_wrapped_dek = wrap_dek(&dek, &pin_kek).unwrap();
        let rec_wrapped_dek = wrap_dek(&dek, &rec_kek).unwrap();
        let verifier = pin_verifier_for_kek(&pin_kek).to_vec();
        crate::crypto::kdf::zeroize_key(&mut pin_kek);
        crate::crypto::kdf::zeroize_key(&mut rec_kek);

        let ts = now_unix() as i64;
        let row = KeywrapRow {
            id: 1,
            role: PinRole::Real,
            pin_salt: pin_salt.to_vec(),
            pin_params: serde_json::to_vec(&pin_params).unwrap(),
            pin_wrapped_dek,
            pin_verifier: verifier,
            rec_salt: rec_salt.to_vec(),
            rec_params: serde_json::to_vec(&rec_params).unwrap(),
            rec_wrapped_dek,
            backup_salt: backup_salt.to_vec(),
            version: 1,
            created_at: ts,
            updated_at: ts,
        };
        write_keywrap_to_keystore(&db_path, &row).expect("keywrap write should persist");

        drop(db);
        let db2 = Db::open(&db_path, &dek).expect("Db::open second time");
        db2.with_conn::<_, _, rusqlite::Error>(|conn| {
            let user_count: i64 = conn.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?;
            assert_eq!(user_count, 1, "owner user should persist");
            let settings_count: i64 =
                conn.query_row("SELECT COUNT(*) FROM settings", [], |r| r.get(0))?;
            assert_eq!(settings_count, 1, "settings row should persist");
            let shop_name: String =
                conn.query_row("SELECT shop_name FROM settings WHERE id=1", [], |r| {
                    r.get(0)
                })?;
            assert_eq!(shop_name, "Test Shop");
            let loc_count: i64 =
                conn.query_row("SELECT COUNT(*) FROM locations", [], |r| r.get(0))?;
            assert_eq!(loc_count, 2, "Shop + Godown locations should persist");
            Ok(())
        })
        .expect("verify after re-open");

        let read_row = read_keywrap_from_keystore(&db_path)
            .expect("keywrap row should be readable after main DB close");
        assert_eq!(read_row.id, 1);
        assert_eq!(read_row.pin_salt, pin_salt.to_vec());

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Regression test for the empty-keystore bug: writing the keywrap row
    /// while the main encrypted DB is open, then reading it back after the
    /// main DB is closed, must return the persisted row.
    #[test]
    fn first_launch_setup_keystore_persists_keywrap_row() {
        use crate::crypto::kdf::{derive_pin_kek, random_dek, random_salt, KdfParams};
        use crate::crypto::wrap::wrap_dek;
        use crate::db::keywrap::KeywrapRow;

        let dir = unique_test_dir("keystore-persist");
        let db_path = dir.join("paintkiduakan.db");

        wipe_existing_setup(&db_path).expect("initial wipe should succeed");

        let dek = random_dek();
        let _db = Db::open(&db_path, &dek).expect("Db::open should succeed");

        let pin = "123456";
        let passphrase = "correct horse battery staple";
        let pin_salt = random_salt();
        let rec_salt = random_salt();
        let backup_salt = random_salt();
        let pin_params = KdfParams::PIN;
        let rec_params = KdfParams::RECOVERY;

        let mut pin_kek = derive_pin_kek(pin, &pin_salt, &pin_params).unwrap();
        let mut rec_kek = derive_pin_kek(passphrase, &rec_salt, &rec_params).unwrap();
        let pin_wrapped_dek = wrap_dek(&dek, &pin_kek).unwrap();
        let rec_wrapped_dek = wrap_dek(&dek, &rec_kek).unwrap();
        crate::crypto::kdf::zeroize_key(&mut pin_kek);
        crate::crypto::kdf::zeroize_key(&mut rec_kek);

        let ts = now_unix() as i64;
        let row = KeywrapRow {
            id: 1,
            role: PinRole::Real,
            pin_verifier: vec![],
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

        write_keywrap_to_keystore(&db_path, &row)
            .expect("write_keywrap_to_keystore should succeed");
        write_lockout_to_keystore(&db_path, &default_lockout_row())
            .expect("write_lockout_to_keystore should succeed");

        let read_row = read_keywrap_from_keystore(&db_path).expect(
            "read_keywrap_from_keystore should find the persisted row while main db is still open",
        );
        assert_eq!(read_row.id, 1);
        assert_eq!(read_row.pin_salt, pin_salt.to_vec());
        assert_eq!(read_row.backup_salt, backup_salt.to_vec());

        std::fs::remove_dir_all(&dir).ok();
    }

    /// End-to-end first-launch setup invocation through the real Tauri
    /// command `first_launch_setup`, verifying that the keystore sidecar
    /// contains the keywrap row after the wizard completes.
    #[test]
    fn first_launch_setup_end_to_end_keystore_persists() {
        use tauri::Manager;

        let app = tauri::test::mock_builder()
            .manage(AppState::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app should build");

        let state = app.state::<AppState>();
        let handle = app.handle();

        let session = first_launch_setup(
            state.clone(),
            handle.clone(),
            "123456".into(),
            "correct horse battery staple".into(),
            "Test Shop".into(),
            "123 Test St".into(),
            "555-0100".into(),
            None,
            None,
            None,
            None,
        )
        .expect("first_launch_setup should succeed");

        assert!(!session.locked);
        assert!(session.user.is_some());

        let db_path = state
            .db_path
            .lock()
            .unwrap()
            .clone()
            .expect("db_path should be set");

        let row = read_keywrap_from_keystore(&db_path)
            .expect("keystore sidecar should contain the keywrap row after setup");
        assert_eq!(row.id, 1);

        wipe_existing_setup(&db_path).ok();
    }

    /// Invariant: `derive_recovery_k` must equal
    /// `derive_pin_kek(..., KdfParams::RECOVERY)`. Asymmetry would silently
    /// break unlock-via-recovery.
    #[test]
    fn recovery_k_matches_pin_kek_with_recovery_params() {
        let passphrase = "correct horse battery staple";
        let salt = crate::crypto::kdf::random_salt();

        let a = kdf::derive_recovery_k(passphrase, &salt).expect("derive_recovery_k");
        let b = kdf::derive_pin_kek(passphrase, &salt, &KdfParams::RECOVERY)
            .expect("derive_pin_kek RECOVERY");

        assert_eq!(a, b, "RECOVERY KDF must be symmetric across write and read");
    }

    /// Simulates the E2E bug: after first_launch_setup returns, the keystore
    /// sidecar MUST contain the keywrap row. Without this guarantee, unlock
    /// after process restart fails with "no keywrap row found" (the b31 bug).
    ///
    /// This test simulates "process restart" by:
    /// 1. running first_launch_setup_at_path (creates DB + keystore sidecar)
    /// 2. dropping all handles (function returns)
    /// 3. opening the keystore afresh via read_keywrap_from_keystore
    /// 4. asserting the row is present and fields are non-empty
    ///
    /// Catches: synchronous=NORMAL with implicit Drop-based close silently
    /// failing to fsync. Fixed by b79aa3a (synchronous=FULL + explicit close).
    #[test]
    fn setup_then_reopen_keywrap_row_survives() {
        use crate::commands::auth::{read_keywrap_from_keystore, AppState};

        let dir = unique_test_dir("setup-reopen");
        let db_path = dir.join("paintkiduakan.db");

        let state = AppState::default();
        let pin = "123456".to_string();
        let passphrase = "very-strong-recovery-passphrase".to_string();

        let session = first_launch_setup_at_path(
            &state,
            &db_path,
            pin.clone(),
            passphrase,
            "Test Shop".to_string(),
            "123 Test St".to_string(),
            "+919876543210".to_string(),
            None,
        )
        .expect("first_launch_setup_at_path should succeed");

        assert_eq!(session.user.as_ref().unwrap().role, "owner");
        assert!(db_path.exists(), "DB file must exist after setup");

        let keystore_path = db_path.with_extension("keystore");
        assert!(
            keystore_path.exists(),
            "keystore sidecar must exist after setup"
        );

        // Simulate "process restart" — open the keystore from scratch.
        let row = read_keywrap_from_keystore(&db_path)
            .expect("keywrap row must be readable after process restart");

        assert_eq!(row.id, 1, "keywrap row must have id=1");
        assert_eq!(
            row.pin_salt.len(),
            32,
            "pin_salt must be 32 bytes (CWE-759)"
        );
        assert!(
            !row.pin_wrapped_dek.is_empty(),
            "pin_wrapped_dek must be non-empty"
        );
        assert_eq!(
            row.rec_salt.len(),
            32,
            "rec_salt must be 32 bytes (CWE-759)"
        );
        assert!(
            !row.rec_wrapped_dek.is_empty(),
            "rec_wrapped_dek must be non-empty"
        );
        assert!(!row.pin_params.is_empty(), "pin_params must be serialized");
        assert!(!row.rec_params.is_empty(), "rec_params must be serialized");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Full setup→restart→unlock roundtrip. Proves the entire cycle works
    /// without a Tauri runtime by closing every handle between phases and
    /// re-opening from scratch. Catches SQLCipher-key / Argon2id / AES-GCM
    /// mismatches between the write path (setup) and read path (unlock).
    #[test]
    fn setup_then_unlock_roundtrip() {
        use crate::commands::auth::{read_keywrap_from_keystore, AppState};
        use crate::db;
        use crate::db::keywrap;

        let dir = unique_test_dir("setup-unlock-roundtrip");
        let db_path = dir.join("paintkiduakan.db");

        let state = AppState::default();
        let pin = "123456".to_string();
        let passphrase = "another-strong-recovery-passphrase";

        first_launch_setup_at_path(
            &state,
            &db_path,
            pin.clone(),
            passphrase.to_string(),
            "Roundtrip Shop".to_string(),
            "Addr".to_string(),
            "+919876543210".to_string(),
            None,
        )
        .expect("setup must succeed");

        drop(state);

        let row = read_keywrap_from_keystore(&db_path).expect("keywrap must survive restart");

        let dek = keywrap::unwrap_with_pin(&row, &pin).expect("PIN unwrap must succeed");

        let db = db::Db::open(&db_path, &dek).expect("SQLCipher DB must open with recovered DEK");

        let table_count: i64 = db
            .with_conn(|c| -> Result<i64, rusqlite::Error> {
                let n: i64 = c.query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'",
                    [],
                    |r| r.get(0),
                )?;
                Ok(n)
            })
            .expect("schema query must succeed after unlock");
        assert!(
            table_count > 0,
            "schema tables must exist after unlock (got {table_count})"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unlock_with_wrong_pin_fails_with_wrong_pin() {
        use crate::db;
        use crate::db::keywrap;

        let dir = unique_test_dir("unlock-wrong-pin");
        let db_path = dir.join("paintkiduakan.db");

        let state = AppState::default();
        let right_pin = "123456".to_string();
        let wrong_pin = "000000".to_string();

        first_launch_setup_at_path(
            &state,
            &db_path,
            right_pin.clone(),
            "a-recovery-passphrase".to_string(),
            "Shop".to_string(),
            "Addr".to_string(),
            "+919876543210".to_string(),
            None,
        )
        .expect("setup must succeed");

        drop(state);

        let row = read_keywrap_from_keystore(&db_path).expect("keywrap must survive restart");

        let err =
            keywrap::unwrap_with_pin(&row, &wrong_pin).expect_err("wrong PIN must be rejected");
        match err {
            crate::AppError::WrongPin => {}
            other => panic!("expected WrongPin, got {other:?}"),
        }

        let _ = db::Db::open(&db_path, &[0u8; 32])
            .err()
            .ok_or_else(|| panic!("zero DEK must NOT open the SQLCipher DB"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn recovery_with_wrong_passphrase_returns_wrong_recovery_passphrase() {
        use crate::db::keywrap;

        let dir = unique_test_dir("recovery-wrong-passphrase");
        let db_path = dir.join("paintkiduakan.db");

        let state = AppState::default();
        let right_passphrase = "right-recovery-passphrase";
        let wrong_passphrase = "wrong-recovery-passphrase";

        first_launch_setup_at_path(
            &state,
            &db_path,
            "123456".to_string(),
            right_passphrase.to_string(),
            "Shop".to_string(),
            "Addr".to_string(),
            "+919876543210".to_string(),
            None,
        )
        .expect("setup must succeed");

        drop(state);

        let row = read_keywrap_from_keystore(&db_path).expect("keywrap must survive restart");

        let err = keywrap::unwrap_with_recovery(&row, wrong_passphrase)
            .expect_err("wrong recovery passphrase must be rejected");
        match err {
            crate::AppError::WrongRecoveryPassphrase => {}
            other => panic!("expected WrongRecoveryPassphrase, got {other:?}"),
        }

        let ok = keywrap::unwrap_with_recovery(&row, right_passphrase);
        assert!(ok.is_ok(), "correct recovery passphrase must unwrap DEK");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn setup_is_idempotent_wipes_then_rebuilds() {
        use crate::db;
        use crate::db::keywrap;

        let dir = unique_test_dir("setup-idempotent");
        let db_path = dir.join("paintkiduakan.db");

        let state = AppState::default();
        let old_pin = "111111".to_string();
        first_launch_setup_at_path(
            &state,
            &db_path,
            old_pin.clone(),
            "old-passphrase".to_string(),
            "Old Shop".to_string(),
            "Old Addr".to_string(),
            "+919876543210".to_string(),
            None,
        )
        .expect("first setup must succeed");
        drop(state);

        let state = AppState::default();
        let new_pin = "222222".to_string();
        first_launch_setup_at_path(
            &state,
            &db_path,
            new_pin.clone(),
            "new-passphrase".to_string(),
            "New Shop".to_string(),
            "New Addr".to_string(),
            "+919876543210".to_string(),
            None,
        )
        .expect("re-setup on existing files must wipe and rebuild");
        drop(state);

        let row = read_keywrap_from_keystore(&db_path).expect("keywrap must exist after re-setup");

        let err = keywrap::unwrap_with_pin(&row, &old_pin)
            .expect_err("old PIN must be rejected after re-setup");
        match err {
            crate::AppError::WrongPin => {}
            other => panic!("expected WrongPin for old PIN, got {other:?}"),
        }

        let dek =
            keywrap::unwrap_with_pin(&row, &new_pin).expect("new PIN must unwrap after re-setup");
        let _db = db::Db::open(&db_path, &dek)
            .expect("SQLCipher DB must open with new DEK after re-setup");

        std::fs::remove_dir_all(&dir).ok();
    }
}

//! Auth slice — Tauri command handlers.
//!
//! Every `#[tauri::command]` function the frontend calls lives here. They are
//! thin orchestrators: validate inputs, call into `lockout`/`keystore`/`session`
//! for the security policy, mutate `AppState`, and return spec-shaped JSON.

use subtle::ConstantTimeEq;
use tauri::{AppHandle, Manager, State};

use crate::crypto::kdf::{self, random_salt};
use crate::db;
use crate::db::keywrap;
use crate::error::AppError;

use super::keystore::{
    read_keywrap_from_keystore, read_lockout_from_keystore, write_keywrap_to_keystore,
};
use super::lockout::{
    clear_lockout, current_lockout_until, handle_lockout, max_failed_attempts,
    read_deception_flag, record_failed_attempt, set_deception_flag, unlock_into_decoy,
    validate_owner_pin, DECEPTION_THRESHOLD,
};
use super::types::{AppState, Bootstrap, Session, UnlockResult, User, now_unix};

// ---------------------------------------------------------------------------
// Bootstrap / wipe
// ---------------------------------------------------------------------------

/// Returns the current bootstrap state of the app.
#[tauri::command(rename_all = "snake_case")]
pub fn app_bootstrap(app: AppHandle, state: State<AppState>) -> Result<Bootstrap, AppError> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
    let db_path = app_dir.join(crate::security::app_paths::db_name());
    let db_exists = db_path.exists();

    // Source of truth for first-launch is the ENCRYPTED DB, not the keystore.
    // A stale keystore (from a crashed setup attempt) without a DB must NOT
    // look "locked" — it should rerun setup, which wipes the sidecar first.
    if !db_exists {
        return Ok(Bootstrap::FirstLaunch);
    }

    // DB exists. Verify the keystore holds a valid keywrap row.
    //
    // Only auto-wipe when the keystore structurally has no keywrap row (e.g.
    // setup crashed after creating the DB but before committing the row).
    // DPAPI/keychain crypto failures must NOT trigger an auto-wipe — the DB
    // is intact, only the OS-level envelope key is unavailable (stale keychain
    // entry, OS reinstall, etc.). Wiping on a crypto error would silently
    // destroy recoverable data every time the keychain drifts.

    // ponytail: set db_path BEFORE keystore check so KeystoreError branch
    // still allows the "Try PIN Unlock" path to call unlock().
    *state.db_path.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = Some(db_path.clone());

    if let Err(e) = read_keywrap_from_keystore(&db_path) {
        let is_empty_keystore =
            matches!(&e, AppError::Db(rusqlite::Error::QueryReturnedNoRows));
        if is_empty_keystore {
            log::warn!("[BOOTSTRAP] Stale state (no keywrap row); wiping for fresh setup");
            crate::commands::recovery::wipe_existing_setup(&db_path)
                .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
            return Ok(Bootstrap::FirstLaunch);
        } else {
            log::warn!("[BOOTSTRAP] Keystore unreadable (data preserved): {e}");
            return Ok(Bootstrap::KeystoreError {
                reason: e.to_string(),
            });
        }
    }

    // Load persisted lockout counter so it survives process restarts.
    match read_lockout_from_keystore(&db_path) {
        Ok(row) => {
            *state.failed_attempts.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = row.failed_attempts as u32;
        }
        Err(AppError::Db(rusqlite::Error::QueryReturnedNoRows)) => {}
        Err(e) => return Err(e),
    }

    let session = state.session.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))?;
    match session.as_ref() {
        None => Ok(Bootstrap::Locked),
        Some(s) => Ok(Bootstrap::Unlocked {
            user_id: s.id,
            user: s.name.clone(),
            role: s.role.clone(),
        }),
    }
}

/// Explicit user-confirmed wipe called from the `keystore_error` recovery screen.
/// Requires the user to actively choose this path — never triggered automatically.
#[tauri::command(rename_all = "snake_case")]
pub fn wipe_and_reset(app: AppHandle, state: State<AppState>) -> Result<(), AppError> {
    let session = state.session.lock().map_err(|e| AppError::Internal(e.to_string()))?;
    if session.is_some() {
        return Err(AppError::Forbidden("wipe_and_reset denied: active session".into()));
    }
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
    let db_path = app_dir.join(crate::security::app_paths::db_name());
    log::warn!("[WIPE_AND_RESET] User-confirmed explicit wipe");
    crate::commands::recovery::wipe_existing_setup(&db_path)
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))
}

// ---------------------------------------------------------------------------
// Unlock / lock
// ---------------------------------------------------------------------------

/// Unlock the database with the owner's PIN.
#[tauri::command(rename_all = "snake_case")]
pub fn unlock(state: State<AppState>, pin: String) -> Result<UnlockResult, AppError> {
    let db_path = {
        let guard = state.db_path.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))?;
        guard.clone().ok_or(AppError::NoDb)?
    };

    validate_owner_pin(&pin)?;

    if let Some(locked_until_unix) = current_lockout_until(&db_path)? {
        let now = now_unix();
        if now < locked_until_unix {
            return Err(AppError::LockedOut {
                until: locked_until_unix * 1000,
            });
        }
        clear_lockout(&db_path, &state)?;
    }

    if read_deception_flag(&db_path)? {
        return unlock_into_decoy(&state, &db_path, &pin);
    }

    let (wipe_enabled, wipe_timeout) = {
        let settings = state.settings.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))?;
        let wipe_enabled = settings
            .get("security.wipe_on_duress")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let wipe_timeout = settings
            .get("security.wipe_timeout_minutes")
            .and_then(|v| v.as_u64())
            .unwrap_or(1);
        (wipe_enabled, wipe_timeout)
    };

    let decoy_db_path = crate::security::pde::decoy_db_path(&db_path);
    let result = crate::security::pin_entry::try_unlock(
        &db_path,
        &pin,
        &db_path,
        &decoy_db_path,
        wipe_enabled,
        wipe_timeout,
    );

    match result {
        Ok(unlock) => {
            let target_db = &unlock.db_path;
            let db = if target_db.exists() {
                db::Db::open(target_db, &unlock.dek).map_err(AppError::Db)?
            } else {
                db::Db::open(&db_path, &unlock.dek).map_err(AppError::Db)?
            };

            let user = db.with_conn(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT id, name, role FROM users WHERE is_active = 1 ORDER BY id LIMIT 1",
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
            crate::commands::settings::hydrate_settings_from_sql(
                state.db.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))?.as_ref().ok_or(AppError::NotUnlocked)?,
                &state.settings,
            );
            *state.session.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = Some(user.clone());
            *state.failed_attempts.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = 0;
            clear_lockout(&db_path, &state)?;
            state
                .last_activity
                .store(now_unix(), std::sync::atomic::Ordering::SeqCst);

            Ok(UnlockResult {
                user: Some(user),
                locked: false,
                pin_role: unlock.role,
                wipe_triggered: unlock.wipe_triggered,
            })
        }
        Err(e) => {
            let attempts = {
                let mut failed = state.failed_attempts.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))?;
                *failed += 1;
                *failed
            };

            record_failed_attempt(&db_path, attempts)?;

            if attempts == DECEPTION_THRESHOLD {
                set_deception_flag(&db_path, true)?;
            }

            if attempts >= max_failed_attempts(&state) {
                handle_lockout(&state, attempts)?;
            }

            Err(e)
        }
    }
}

/// Lock the database — drops the DEK (zeroized via Drop) and the cached
/// recovery passphrase (Zeroizing clears the bytes on reassignment).
#[tauri::command(rename_all = "snake_case")]
pub fn lock(state: State<AppState>) -> Result<(), AppError> {
    // Ponytail: require active session to lock — prevents unauthenticated DoS
    {
        let guard = state.session.lock().map_err(|_| AppError::Internal("session mutex poisoned".into()))?;
        guard.as_ref().ok_or(AppError::Forbidden("no active session".into()))?;
    }
    if let Some(ref p) = *state.db_path.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? {
        let _ = set_deception_flag(p, false);
    }
    *state.db.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = None;
    *state.session.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = None;
    *state.recovery_passphrase.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = None;
    Ok(())
}

/// Update the last-activity timestamp (called by frontend on user interaction).
#[tauri::command(rename_all = "snake_case")]
pub fn touch_activity(state: State<AppState>) -> Result<(), AppError> {
    state
        .last_activity
        .store(now_unix(), std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

/// Change the owner PIN (owner-only).
#[tauri::command(rename_all = "snake_case")]
pub fn change_pin(
    state: State<AppState>,
    old_pin: String,
    new_pin: String,
) -> Result<(), AppError> {
    let session = state.session.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))?;
    let session_ref = session.as_ref().ok_or(AppError::NotUnlocked)?;
    if session_ref.role != "owner" {
        return Err(AppError::Unauthorized("owner role required".into()));
    }
    drop(session);

    // Defense-in-depth: validate new PIN format on the Rust side too.
    validate_owner_pin(&new_pin)?;

    let db_path = state
        .db_path
        .lock()
        .map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))?
        .clone()
        .ok_or(AppError::NoDb)?;
    let db = state.db.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))?;
    let db = db.as_ref().ok_or(AppError::NotUnlocked)?;

    let dek = db.dek();

    // Read existing keywrap, verify old PIN.
    let mut row = read_keywrap_from_keystore(&db_path)?;
    let _ = keywrap::unwrap_with_pin(&row, &old_pin)?; // verify old PIN

    // Rewrap with new PIN.
    keywrap::rewrap_pin(&mut row, dek, &new_pin)?;

    // Persist updated keywrap.
    write_keywrap_to_keystore(&db_path, &row)?;

    Ok(())
}

// ---------------------------------------------------------------------------
// User management (owner-only)
// ---------------------------------------------------------------------------

/// Create a new cashier or stocker user. Owner-only.
#[tauri::command(rename_all = "snake_case")]
pub fn create_user(
    state: State<AppState>,
    name: String,
    role: String,
    pin: String,
) -> Result<User, AppError> {
    // Only the owner can create users.
    {
        let session = state.session.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))?;
        let s = session.as_ref().ok_or(AppError::NotUnlocked)?;
        if s.role != "owner" {
            return Err(AppError::Unauthorized("owner role required".into()));
        }
    }

    // Validate role.
    if role != "cashier" && role != "stocker" {
        return Err(AppError::Crypto(
            "role must be 'cashier' or 'stocker'".into(),
        ));
    }

    // Validate PIN format (6 digits).
    validate_owner_pin(&pin)?;

    // Validate name is non-empty.
    if name.trim().is_empty() {
        return Err(AppError::Crypto("user name cannot be empty".into()));
    }

    let db = state.db.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))?;
    let db = db.as_ref().ok_or(AppError::NotUnlocked)?;

    // Generate per-user PIN salt and verifier.
    let salt = random_salt();
    let params = kdf::KdfParams::PIN;
    let mut kek =
        kdf::derive_pin_kek(&pin, &salt, &params).map_err(|e| AppError::Crypto(e.to_string()))?;
    // Store the KEK as the verifier (the DB-level per-user auth checks
    // re-deriving this from input PIN against stored salt).
    let verifier: Vec<u8> = kek.to_vec();
    kdf::zeroize_key(&mut kek);

    let salt_bytes = salt.to_vec();

    let ts = (now_unix() as i64) * 1000;
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, 6, ?5, ?6)",
            rusqlite::params![name, role, &salt_bytes, &verifier, ts, ts],
        )
    })
    .map_err(AppError::Db)?;

    // Read back the inserted user to get the id.
    let user = db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, role FROM users WHERE name = ?1 AND is_active = 1 LIMIT 1",
        )?;
        stmt.query_row(rusqlite::params![name], |r| {
            Ok(User {
                id: r.get(0)?,
                name: r.get(1)?,
                role: r.get(2)?,
                is_active: true,
            })
        })
    })?;

    Ok(user)
}

/// List all active users (owner-only).
#[tauri::command(rename_all = "snake_case")]
pub fn list_users(state: State<AppState>) -> Result<Vec<User>, AppError> {
    {
        let session = state.session.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))?;
        let s = session.as_ref().ok_or(AppError::NotUnlocked)?;
        if s.role != "owner" {
            return Err(AppError::Unauthorized("owner role required".into()));
        }
    }

    let db = state.db.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))?;
    let db = db.as_ref().ok_or(AppError::NotUnlocked)?;

    let users = db.with_conn(|conn| {
        let mut stmt =
            conn.prepare("SELECT id, name, role, is_active FROM users ORDER BY role, name")?;
        let rows = stmt.query_map([], |r| {
            Ok(User {
                id: r.get(0)?,
                name: r.get(1)?,
                role: r.get(2)?,
                is_active: r.get::<_, i64>(3)? != 0,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
    })?;

    Ok(users)
}

#[tauri::command(rename_all = "snake_case")]
pub fn logout_for_switch(state: State<AppState>) -> Result<Vec<User>, AppError> {
    {
        let session = state.session.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))?;
        session.as_ref().ok_or(AppError::NotUnlocked)?;
    }

    let users = {
        let db = state.db.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))?;
        let db = db.as_ref().ok_or(AppError::NotUnlocked)?;
        db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, name, role, is_active FROM users WHERE is_active = 1 ORDER BY role, name",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(User {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    role: r.get(2)?,
                    is_active: r.get::<_, i64>(3)? != 0,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()
        })?
    };

    *state.session.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = None;
    Ok(users)
}

/// Deactivate a user. Owner-only. Cannot deactivate yourself.
#[tauri::command(rename_all = "snake_case")]
pub fn delete_user(state: State<AppState>, user_id: i64) -> Result<(), AppError> {
    {
        let session = state.session.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))?;
        let s = session.as_ref().ok_or(AppError::NotUnlocked)?;
        if s.role != "owner" {
            return Err(AppError::Unauthorized("owner role required".into()));
        }
        if s.id == user_id {
            return Err(AppError::Crypto(
                "cannot deactivate your own account".into(),
            ));
        }
    }

    let db = state.db.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))?;
    let db = db.as_ref().ok_or(AppError::NotUnlocked)?;

    let affected = db
        .with_conn(|conn| {
            conn.execute(
                "UPDATE users SET is_active = 0 WHERE id = ?1 AND is_active = 1",
                rusqlite::params![user_id],
            )
        })
        .map_err(AppError::Db)?;

    if affected == 0 {
        return Err(AppError::Crypto("user not found".into()));
    }

    Ok(())
}

/// Non-owner login: authenticate a cashier or stocker by name + PIN.
///
/// Only works when the DB is already decrypted (owner must have unlocked first).
/// Returns a Session with the authenticated user.
/// Enforces the same lockout/backoff policy as owner unlock (CWE custom #9).
#[tauri::command(rename_all = "snake_case")]
pub fn login_user(state: State<AppState>, name: String, pin: String) -> Result<Session, AppError> {
    validate_owner_pin(&pin)?;

    // Check active lockout (same policy as owner unlock — CWE custom #9).
    let db_path = state
        .db_path
        .lock()
        .map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))?
        .clone()
        .ok_or(AppError::NoDb)?;

    // If deception mode is tripped, reject cashier/stocker login (same as owner).
    if read_deception_flag(&db_path)? {
        return Err(AppError::WrongPin);
    }

    if let Some(locked_until_unix) = current_lockout_until(&db_path)? {
        let now = now_unix();
        if now < locked_until_unix {
            return Err(AppError::LockedOut {
                until: locked_until_unix * 1000,
            });
        }
        clear_lockout(&db_path, &state)?;
    }

    let db = state.db.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))?;
    let db = db.as_ref().ok_or(AppError::NotUnlocked)?;

    // Look up user by name.
    let user = db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, role, pin_salt, pin_verifier \
             FROM users WHERE name = ?1 AND is_active = 1 LIMIT 1",
        )?;
        stmt.query_row(rusqlite::params![name], |r| {
            let id: i64 = r.get(0)?;
            let name: String = r.get(1)?;
            let role: String = r.get(2)?;
            let salt: Vec<u8> = r.get(3)?;
            let verifier: Vec<u8> = r.get(4)?;
            Ok((id, name, role, salt, verifier))
        })
    });

    let (id, name, role, salt, verifier) = match user {
        Ok(u) => u,
        Err(_) => {
            // CWE-208: equalize timing — run dummy KDF so username-not-found
            // takes the same time as a real login (~500ms Argon2id).
            let dummy_salt = kdf::random_salt();
            let params = kdf::KdfParams::PIN;
            let mut dummy_kek =
                kdf::derive_pin_kek(&pin, &dummy_salt, &params).map_err(|e| AppError::Crypto(e.to_string()))?;
            kdf::zeroize_key(&mut dummy_kek);
            return Err(AppError::WrongPin);
        }
    };

    // Derive KEK from input PIN and compare against stored verifier.
    let params = kdf::KdfParams::PIN;
    let mut kek =
        kdf::derive_pin_kek(&pin, &salt, &params).map_err(|e| AppError::Crypto(e.to_string()))?;
    let derived_verifier = kek.to_vec();
    kdf::zeroize_key(&mut kek);

    // CWE-208: constant-time compare to prevent timing side-channel.
    if derived_verifier.ct_eq(&verifier).unwrap_u8() == 0 {
        // Record failed attempt and enforce lockout (CWE custom #9).
        let attempts = {
            let mut failed = state.failed_attempts.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))?;
            *failed += 1;
            *failed
        };
        record_failed_attempt(&db_path, attempts)?;
        if attempts >= max_failed_attempts(&state) {
            handle_lockout(&state, attempts)?;
        }
        if attempts == DECEPTION_THRESHOLD {
            set_deception_flag(&db_path, true)?;
        }
        return Err(AppError::WrongPin);
    }

    let authenticated_user = User {
        id,
        name,
        role,
        is_active: true,
    };
    *state.session.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = Some(authenticated_user.clone());
    *state.failed_attempts.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = 0;
    clear_lockout(&db_path, &state)?;

    Ok(Session {
        user: Some(authenticated_user),
        locked: false,
    })
}



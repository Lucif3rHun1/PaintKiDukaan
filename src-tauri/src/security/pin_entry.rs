use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

use crate::db::keywrap::{self, PinRole};
use crate::error::AppError;

#[derive(Debug)]
pub struct UnlockResult {
    pub role: PinRole,
    pub dek: Zeroizing<[u8; 32]>,
    pub db_path: PathBuf,
    pub wipe_triggered: bool,
}

/// Try to unlock with the given PIN against all 3 PDE keywrap rows.
///
/// For each row (real, decoy, duress):
///   1. Derive KEK from PIN + row's salt + params
///   2. Attempt AES-GCM unwrap of row's wrapped_dek
///   3. If success: this is the matching PIN
///
/// On duress match: schedules background secure-delete of real DB.
/// On real/decoy match: returns the corresponding DEK and DB path.
pub fn try_unlock(
    db_path: &Path,
    pin: &str,
    real_db_path: &Path,
    decoy_db_path: &Path,
) -> Result<UnlockResult, AppError> {
    let kp = crate::commands::auth::keystore_path(db_path);
    let conn = crate::commands::auth::open_keystore(&kp)?;
    let rows = keywrap::read_all(&conn)?;

    if rows.is_empty() {
        return Err(AppError::NoKeywrap);
    }

    let mut last_err: Option<AppError> = None;

    for row in &rows {
        match keywrap::unwrap_with_pin(row, pin) {
            Ok(dek) => {
                let (target_db, wipe) = match row.role {
                    PinRole::Real => (real_db_path.to_path_buf(), false),
                    PinRole::Decoy => (decoy_db_path.to_path_buf(), false),
                    PinRole::Duress => {
                        spawn_duress_wipe(real_db_path, db_path);
                        (decoy_db_path.to_path_buf(), true)
                    }
                };
                return Ok(UnlockResult {
                    role: row.role,
                    dek,
                    db_path: target_db,
                    wipe_triggered: wipe,
                });
            }
            Err(e) => {
                last_err = Some(e);
            }
        }
    }

    Err(last_err.unwrap_or(AppError::WrongPin))
}

/// Spawn a background thread to secure-delete the real DB and its keywrap row.
/// Best-effort: if the attacker pulls power, partial wipe may have occurred.
fn spawn_duress_wipe(real_db_path: &Path, keystore_db_path: &Path) {
    let real = real_db_path.to_path_buf();
    let ks = keystore_db_path.to_path_buf();

    std::thread::Builder::new()
        .name("pkb-duress-wipe".into())
        .spawn(move || {
            // Secure-delete the real DB + WAL + SHM.
            for ext in ["", "-wal", "-shm"] {
                let mut p = real.clone();
                if ext.is_empty() {
                    // keep original path
                } else {
                    p = real.with_extension(format!("db{ext}"));
                }
                let _ = crate::security::anti_forensic::secure_delete(&p);
            }

            // Remove the real keywrap row from the keystore.
            if let Ok(conn) = crate::commands::auth::open_keystore(&ks) {
                let _ = keywrap::delete_by_role(&conn, PinRole::Real);
            }

            // Trigger anti-forensic scrub if available.
            let _ = crate::security::anti_forensic::clear_shellbags_and_recent();
            let _ = crate::security::anti_forensic::clear_thumbnail_cache();
        })
        .ok();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::kdf;
    use crate::crypto::kdf::{derive_pin_kek, random_dek, random_salt, KdfParams};
    use crate::crypto::wrap::wrap_dek;
    use crate::db::keywrap::{pin_verifier_for_kek, KeywrapRow, PinRole, KEYSTORE_SCHEMA};

    fn setup_pde_keystore(
        dir: &Path,
        real_pin: &str,
        decoy_pin: &str,
        duress_pin: &str,
    ) -> PathBuf {
        let db_path = dir.join("test.db");
        let keystore_path = db_path.with_extension("keystore");

        let conn = rusqlite::Connection::open(&keystore_path).unwrap();
        conn.execute_batch(KEYSTORE_SCHEMA).unwrap();

        let dek_real = random_dek();
        let dek_decoy = random_dek();
        let ts = 1000i64;
        let pin_params = serde_json::to_vec(&KdfParams::PIN).unwrap();
        let rec_params = serde_json::to_vec(&KdfParams::RECOVERY).unwrap();
        let pin_salt = random_salt().to_vec();
        let rec_salt = random_salt().to_vec();
        let backup_salt = random_salt().to_vec();

        for (id, role, pin, dek) in [
            (1, PinRole::Real, real_pin, &dek_real),
            (2, PinRole::Decoy, decoy_pin, &dek_decoy),
            (3, PinRole::Duress, duress_pin, &dek_decoy),
        ] {
            let mut kek = derive_pin_kek(pin, &pin_salt, &KdfParams::PIN).unwrap();
            let verifier = pin_verifier_for_kek(&kek).to_vec();
            let wrapped = wrap_dek(dek, &kek).unwrap();
            kdf::zeroize_key(&mut kek);

            let row = KeywrapRow {
                id,
                role,
                pin_salt: pin_salt.clone(),
                pin_params: pin_params.clone(),
                pin_wrapped_dek: wrapped,
                pin_verifier: verifier,
                rec_salt: rec_salt.clone(),
                rec_params: rec_params.clone(),
                rec_wrapped_dek: vec![],
                backup_salt: backup_salt.clone(),
                version: 1,
                created_at: ts,
                updated_at: ts,
            };
            keywrap::upsert(&conn, &row).unwrap();
        }

        keystore_path
    }

    #[test]
    fn try_unlock_real_pin() {
        let dir = tempfile::tempdir().unwrap();
        let real_db = dir.path().join("real.db");
        let decoy_db = dir.path().join("decoy.db");
        let ks = setup_pde_keystore(dir.path(), "111111", "222222", "333333");
        let db_path = ks.with_extension("db");

        let result = try_unlock(&db_path, "111111", &real_db, &decoy_db).unwrap();
        assert_eq!(result.role, PinRole::Real);
        assert!(!result.wipe_triggered);
        assert_eq!(result.db_path, real_db);
    }

    #[test]
    fn try_unlock_decoy_pin() {
        let dir = tempfile::tempdir().unwrap();
        let real_db = dir.path().join("real.db");
        let decoy_db = dir.path().join("decoy.db");
        let ks = setup_pde_keystore(dir.path(), "111111", "222222", "333333");
        let db_path = ks.with_extension("db");

        let result = try_unlock(&db_path, "222222", &real_db, &decoy_db).unwrap();
        assert_eq!(result.role, PinRole::Decoy);
        assert!(!result.wipe_triggered);
        assert_eq!(result.db_path, decoy_db);
    }

    #[test]
    fn try_unlock_wrong_pin() {
        let dir = tempfile::tempdir().unwrap();
        let real_db = dir.path().join("real.db");
        let decoy_db = dir.path().join("decoy.db");
        let ks = setup_pde_keystore(dir.path(), "111111", "222222", "333333");
        let db_path = ks.with_extension("db");

        let err =
            try_unlock(&db_path, "999999", &real_db, &decoy_db).expect_err("wrong pin should fail");
        assert!(matches!(err, AppError::WrongPin));
    }
}

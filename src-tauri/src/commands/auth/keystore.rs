//! Auth slice — encrypted keystore sidecar.
//!
//! Owns the SQLite file that lives next to the main DB and stores the
//! `keywrap` and `lockouts` rows. The sidecar is DPAPI/keychain-encrypted on
//! disk; the plaintext is decrypted into a private tempdir on open and
//! re-encrypted + secure-deleted on close.

use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::crypto::wrap;
use crate::db;
use crate::db::keywrap::{self, KeywrapRow};
use crate::error::AppError;
use crate::security::dpapi_keystore;

pub(crate) fn keystore_path(db_path: &Path) -> PathBuf {
    let mut p = db_path.to_path_buf();
    p.set_extension("keystore");
    p
}

/// On Unix, restrict tempdir to owner-only access. Windows inherits the user's profile ACL.
#[cfg(unix)]
fn lock_dir_perms(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let perms = std::fs::Permissions::from_mode(0o700);
    std::fs::set_permissions(path, perms)
}
#[cfg(not(unix))]
fn lock_dir_perms(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Guard over a decrypted keystore tempfile inside a locked tempdir.
///
/// On creation: creates a private tempdir (0700 on Unix), reads the encrypted
/// blob from `original_path`, decrypts via [`dpapi_keystore::decrypt_keystore`],
/// writes plaintext to a file inside the tempdir, opens a SQLite [`Connection`]
/// on it. The keystore file MUST be encrypted — plaintext legacy files are
/// refused outright (CWE-345/20: a pre-placed plaintext file would let an
/// attacker choose the PIN-verifier that opens the real DB).
///
/// On [`close`](Self::close): closes the connection, reads the (possibly
/// modified) tempfile, encrypts via [`dpapi_keystore::encrypt_keystore`], and
/// writes the ciphertext back to `original_path`.
///
/// On [`Drop`]: best-effort close + re-encryption + secure-delete of the
/// plaintext file before the tempdir is removed. Write paths should call
/// `close()` to propagate errors via `?`.
pub(crate) struct KeystoreConn {
    conn: Option<Connection>,
    /// Held to keep the private tempdir alive; its Drop removes the directory.
    /// Reads via Drop on `KeystoreConn` — direct access is via `keystore_path`.
    #[allow(dead_code)]
    temp_dir: tempfile::TempDir,
    keystore_path: PathBuf,
    original_path: PathBuf,
    db_id: String,
}

impl KeystoreConn {
    /// Close the connection and re-encrypt the keystore to the original path.
    /// Callers on write paths MUST call this instead of relying on Drop so
    /// that encryption errors are propagated.
    pub fn close(mut self) -> Result<(), AppError> {
        if let Some(conn) = self.conn.take() {
            conn.close().map_err(|(_, e)| AppError::Db(e))?;
        }
        self.seal()
    }

    fn seal(&self) -> Result<(), AppError> {
        let plaintext = std::fs::read(&self.keystore_path)?;
        let encrypted = dpapi_keystore::encrypt_keystore(&plaintext, &self.db_id)?;
        std::fs::write(&self.original_path, encrypted)?;
        Ok(())
    }
}

impl std::ops::Deref for KeystoreConn {
    type Target = Connection;
    // Deref trait requires &Connection; can't return Result.
    // This panic is unreachable: callers only deref while KeystoreConn is alive.
    fn deref(&self) -> &Connection {
        self.conn
            .as_ref()
            .expect("keystore connection already closed")
    }
}

impl Drop for KeystoreConn {
    fn drop(&mut self) {
        // Close the connection first so WAL/SHM are flushed to the tempfile.
        if let Some(conn) = self.conn.take() {
            let _ = conn.close();
        }
        // Best-effort re-encryption. Write callers should use close() to propagate.
        if let Err(e) = self.seal() {
            log::error!("keystore re-encryption failed on drop: {e}");
        }
        // Secure-delete the plaintext file before TempDir removes the directory.
        let _ = crate::security::anti_forensic::secure_delete(&self.keystore_path);
    }
}

/// Open (or create) the keystore and ensure the keywrap table exists.
///
/// Reads the encrypted keystore blob from disk, decrypts it via
/// [`dpapi_keystore::decrypt_keystore`], and opens a SQLite connection on the
/// plaintext tempfile. On close/drop the plaintext is re-encrypted and written
/// back to the original path.
///
/// Plaintext legacy keystores are REFUSED outright (CWE-345/20: an attacker
/// who can write the sidecar file could otherwise pre-place a SQLite file
/// with a chosen `pin_verifier` and unlock the real DB). First-launch
/// installs always create an encrypted keystore, so existing plaintext
/// sidecars only appear on hand-edited installs — those must wipe + restore
/// from recovery.
pub(crate) fn open_keystore(path: &Path) -> Result<KeystoreConn, AppError> {
    let temp_dir = tempfile::TempDir::new()?;
    lock_dir_perms(temp_dir.path())?;
    let keystore_path = temp_dir.path().join("keystore.sqlite");

    if path.exists() {
        let raw = std::fs::read(path)?;
        if dpapi_keystore::is_sqlite_plaintext(&raw) {
            return Err(AppError::Crypto(
                "keystore is not encrypted — refusing to open. Restore from recovery.".into(),
            ));
        }
        let plaintext = dpapi_keystore::decrypt_keystore(&raw, &path.to_string_lossy())?;
        std::fs::write(&keystore_path, &plaintext)?;
    }

    let conn = Connection::open(&keystore_path)?;
    conn.execute_batch(db::keywrap::KEYSTORE_SCHEMA)?;
    db::keywrap::migrate_keystore_schema(&conn).map_err(AppError::Db)?;
    conn.execute_batch("PRAGMA synchronous = FULL;")?;

    Ok(KeystoreConn {
        conn: Some(conn),
        temp_dir,
        keystore_path,
        original_path: path.to_path_buf(),
        db_id: path.to_string_lossy().to_string(),
    })
}

/// Read the singleton keywrap row from the keystore.
pub(crate) fn read_keywrap_from_keystore(db_path: &Path) -> Result<KeywrapRow, AppError> {
    let kp = keystore_path(db_path);
    let conn = open_keystore(&kp)?;
    keywrap::read(&conn)
}

pub(crate) fn write_keywrap_to_keystore(db_path: &Path, row: &KeywrapRow) -> Result<(), AppError> {
    let kp = keystore_path(db_path);
    let conn = open_keystore(&kp)?;
    keywrap::upsert(&conn, row)?;
    conn.close()
}

pub(crate) fn read_lockout_from_keystore(db_path: &Path) -> Result<keywrap::LockoutRow, AppError> {
    let kp = keystore_path(db_path);
    let conn = open_keystore(&kp)?;
    keywrap::read_lockout(&conn, 1).map_err(AppError::Db)
}

pub(crate) fn write_lockout_to_keystore(
    db_path: &Path,
    row: &keywrap::LockoutRow,
) -> Result<(), AppError> {
    let kp = keystore_path(db_path);
    let conn = open_keystore(&kp)?;
    keywrap::write_lockout(&conn, row).map_err(AppError::Db)?;
    conn.close()
}

pub(crate) fn clear_lockout_keystore(db_path: &Path) -> Result<(), AppError> {
    let kp = keystore_path(db_path);
    let conn = open_keystore(&kp)?;
    keywrap::clear_lockout(&conn, 1).map_err(AppError::Db)?;
    conn.close()
}

pub fn default_lockout_row() -> keywrap::LockoutRow {
    keywrap::LockoutRow {
        user_id: 1,
        failed_attempts: 0,
        locked_until: None,
        wipe_on_next_fail: false,
        action: "timeout".to_string(),
        base_minutes: 15,
        deception_mode: 0,
    }
}

/// Encrypt the keystore blob with the DEK (CWE-312, CWE-732).
/// Returns `nonce(12) || ciphertext || tag(16)`.
pub fn encrypt_keystore_blob(dek: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, AppError> {
    wrap::encrypt_blob(dek, plaintext)
        .map_err(|e| AppError::Crypto(format!("keystore encryption failed: {e}")))
}

/// Decrypt the keystore blob with the DEK.
pub fn decrypt_keystore_blob(dek: &[u8; 32], ciphertext: &[u8]) -> Result<Vec<u8>, AppError> {
    wrap::decrypt_blob(dek, ciphertext)
        .map_err(|e| AppError::Crypto(format!("keystore decryption failed: {e}")))
}

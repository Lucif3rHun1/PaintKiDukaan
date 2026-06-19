//! Reads and writes the `keywrap` singleton row, and provides DEK
//! wrapping/unwrapping via the [`crypto`] module.
//!
//! The keywrap row lives in a separate unencrypted SQLite sidecar file
//! (`<db_path>.keystore`) so it can be read without the DEK — needed to
//! bootstrap `unlock`. See `commands::auth::open_keystore` for the file
//! location and `KEYSTORE_SCHEMA` for the table DDL.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::crypto::kdf::{self, derive_pin_kek, KdfParams};
use crate::crypto::wrap::{unwrap_dek, wrap_dek};

// ---------------------------------------------------------------------------
// Schema (shared between production `open_keystore` and tests)
// ---------------------------------------------------------------------------

/// DDL for the unencrypted keywrap sidecar DB. Single `keywrap` row at id=1,
/// plus a `lockouts` table so lockout state can be read before the main DB is
/// unlocked.
pub const KEYSTORE_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS keywrap (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  pin_salt BLOB NOT NULL,
  pin_params BLOB NOT NULL,
  pin_wrapped_dek BLOB NOT NULL,
  rec_salt BLOB NOT NULL,
  rec_params BLOB NOT NULL,
  rec_wrapped_dek BLOB NOT NULL,
  backup_salt BLOB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lockouts (
  user_id INTEGER PRIMARY KEY,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  wipe_on_next_fail INTEGER NOT NULL DEFAULT 0,
  action TEXT NOT NULL DEFAULT 'timeout',
  base_minutes INTEGER NOT NULL DEFAULT 15
);";

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

/// Mirrors the `keywrap` table row (id = 1).
///
/// Column naming is internal to the keywrap layer; the operational location
/// is the sidecar `<db_path>.keystore` file, not the encrypted main DB.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeywrapRow {
    pub id: i64,
    pub pin_salt: Vec<u8>,
    pub pin_params: Vec<u8>,
    pub pin_wrapped_dek: Vec<u8>,
    pub rec_salt: Vec<u8>,
    pub rec_params: Vec<u8>,
    pub rec_wrapped_dek: Vec<u8>,
    /// 16-byte salt for backup-key derivation (decision 0.14).
    /// `backup_key = Argon2id(recovery_passphrase, backup_salt)` using the
    /// recovery params (256 MiB / t=3 / p=1).
    pub backup_salt: Vec<u8>,
    pub version: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Lockout state persisted in the unencrypted keywrap sidecar so it can be
/// enforced before the main encrypted DB is unlocked.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LockoutRow {
    pub user_id: i64,
    pub failed_attempts: i64,
    pub locked_until: Option<i64>,
    pub wipe_on_next_fail: bool,
    pub action: String,
    pub base_minutes: i64,
}

// ---------------------------------------------------------------------------
// CRUD helpers
// ---------------------------------------------------------------------------

/// Read the singleton keywrap row.
pub fn read(conn: &Connection) -> Result<KeywrapRow, crate::AppError> {
    let mut stmt = conn.prepare(
        "SELECT id, pin_salt, pin_params, pin_wrapped_dek, \
         rec_salt, rec_params, rec_wrapped_dek, backup_salt, \
         version, created_at, updated_at \
         FROM keywrap WHERE id = 1",
    )?;

    let row = stmt
        .query_row([], |r| {
            Ok(KeywrapRow {
                id: r.get(0)?,
                pin_salt: r.get(1)?,
                pin_params: r.get(2)?,
                pin_wrapped_dek: r.get(3)?,
                rec_salt: r.get(4)?,
                rec_params: r.get(5)?,
                rec_wrapped_dek: r.get(6)?,
                backup_salt: r.get(7)?,
                version: r.get(8)?,
                created_at: r.get(9)?,
                updated_at: r.get(10)?,
            })
        })
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => crate::AppError::NoKeywrap,
            other => crate::AppError::Db(other),
        })?;

    Ok(row)
}

/// Insert the initial keywrap row (INSERT OR IGNORE for safety).
pub fn write_initial(conn: &Connection, row: &KeywrapRow) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT OR IGNORE INTO keywrap \
         (id, pin_salt, pin_params, pin_wrapped_dek, \
          rec_salt, rec_params, rec_wrapped_dek, backup_salt, \
          version, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        rusqlite::params![
            1i64,
            &row.pin_salt,
            &row.pin_params,
            &row.pin_wrapped_dek,
            &row.rec_salt,
            &row.rec_params,
            &row.rec_wrapped_dek,
            &row.backup_salt,
            row.version,
            row.created_at,
            row.updated_at,
        ],
    )?;
    Ok(())
}

/// Update the existing keywrap row.
pub fn update(conn: &Connection, row: &KeywrapRow) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE keywrap SET \
         pin_salt = ?1, pin_params = ?2, pin_wrapped_dek = ?3, \
         rec_salt = ?4, rec_params = ?5, rec_wrapped_dek = ?6, \
         backup_salt = ?7, version = ?8, updated_at = ?9 \
         WHERE id = 1",
        rusqlite::params![
            &row.pin_salt,
            &row.pin_params,
            &row.pin_wrapped_dek,
            &row.rec_salt,
            &row.rec_params,
            &row.rec_wrapped_dek,
            &row.backup_salt,
            row.version,
            row.updated_at,
        ],
    )?;
    Ok(())
}

/// Upsert the singleton keywrap row. This is the production write path used
/// by PIN change, recovery passphrase change, and recovery restore.
pub fn upsert(conn: &Connection, row: &KeywrapRow) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO keywrap \
         (id, pin_salt, pin_params, pin_wrapped_dek, \
          rec_salt, rec_params, rec_wrapped_dek, backup_salt, \
          version, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) \
         ON CONFLICT(id) DO UPDATE SET \
           pin_salt = excluded.pin_salt, \
           pin_params = excluded.pin_params, \
           pin_wrapped_dek = excluded.pin_wrapped_dek, \
           rec_salt = excluded.rec_salt, \
           rec_params = excluded.rec_params, \
           rec_wrapped_dek = excluded.rec_wrapped_dek, \
           backup_salt = excluded.backup_salt, \
           version = excluded.version, \
           updated_at = excluded.updated_at",
        params![
            1i64,
            &row.pin_salt,
            &row.pin_params,
            &row.pin_wrapped_dek,
            &row.rec_salt,
            &row.rec_params,
            &row.rec_wrapped_dek,
            &row.backup_salt,
            row.version,
            row.created_at,
            row.updated_at,
        ],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Lockout helpers
// ---------------------------------------------------------------------------

/// Read the lockout row for `user_id` from the sidecar.
pub fn read_lockout(conn: &Connection, user_id: i64) -> Result<LockoutRow, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT user_id, failed_attempts, locked_until, wipe_on_next_fail, action, base_minutes \
         FROM lockouts WHERE user_id = ?1",
    )?;
    stmt.query_row([user_id], |r| {
        Ok(LockoutRow {
            user_id: r.get(0)?,
            failed_attempts: r.get(1)?,
            locked_until: r.get(2)?,
            wipe_on_next_fail: r.get::<_, i64>(3)? != 0,
            action: r.get(4)?,
            base_minutes: r.get(5)?,
        })
    })
}

/// Upsert a lockout row.
pub fn write_lockout(conn: &Connection, row: &LockoutRow) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO lockouts (user_id, failed_attempts, locked_until, wipe_on_next_fail, action, base_minutes) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
         ON CONFLICT(user_id) DO UPDATE SET \
           failed_attempts = excluded.failed_attempts, \
           locked_until = excluded.locked_until, \
           wipe_on_next_fail = excluded.wipe_on_next_fail, \
           action = excluded.action, \
           base_minutes = excluded.base_minutes",
        params![
            row.user_id,
            row.failed_attempts,
            row.locked_until,
            row.wipe_on_next_fail as i64,
            row.action,
            row.base_minutes,
        ],
    )?;
    Ok(())
}

/// Delete the lockout row for `user_id`.
pub fn clear_lockout(conn: &Connection, user_id: i64) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM lockouts WHERE user_id = ?1", [user_id])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Unwrap helpers
// ---------------------------------------------------------------------------

/// Derive the PIN KEK from the stored salt + params, then unwrap the DEK.
pub fn unwrap_with_pin(row: &KeywrapRow, pin: &str) -> Result<Zeroizing<[u8; 32]>, crate::AppError> {
    let params: KdfParams = serde_json::from_slice(&row.pin_params)
        .map_err(|e| crate::AppError::Crypto(format!("bad pin_params: {e}")))?;

    let mut kek = derive_pin_kek(pin, &row.pin_salt, &params)
        .map_err(|e| crate::AppError::Crypto(e.to_string()))?;

    let dek = unwrap_dek(&row.pin_wrapped_dek, &kek)
        .map_err(|_| crate::AppError::WrongPin)?;

    kdf::zeroize_key(&mut kek);
    Ok(Zeroizing::new(dek))
}

/// Derive the recovery KEK from the stored salt + params, then unwrap the DEK.
pub fn unwrap_with_recovery(
    row: &KeywrapRow,
    passphrase: &str,
) -> Result<Zeroizing<[u8; 32]>, crate::AppError> {
    let params: KdfParams = serde_json::from_slice(&row.rec_params)
        .map_err(|e| crate::AppError::Crypto(format!("bad rec_params: {e}")))?;

    let mut kek = derive_pin_kek(passphrase, &row.rec_salt, &params)
        .map_err(|e| crate::AppError::Crypto(e.to_string()))?;

    let dek = unwrap_dek(&row.rec_wrapped_dek, &kek)
        .map_err(|_| crate::AppError::WrongPin)?;

    kdf::zeroize_key(&mut kek);
    Ok(Zeroizing::new(dek))
}

/// Derive the backup encryption key from the recovery passphrase and stored
/// backup salt. Per decision 0.14: `Argon2id(recovery_passphrase, backup_salt)`
/// using the recovery params (256 MiB / t=3 / p=1).
///
/// Slice D's backup module calls this. The returned `Zeroizing<[u8;32]>` is
/// zeroized on drop.
pub fn derive_backup_key(
    row: &KeywrapRow,
    recovery_passphrase: &str,
) -> Result<Zeroizing<[u8; 32]>, crate::AppError> {
    let raw = derive_pin_kek(recovery_passphrase, &row.backup_salt, &KdfParams::RECOVERY)
        .map_err(|e| crate::AppError::Crypto(e.to_string()))?;
    Ok(Zeroizing::new(raw))
}

// ---------------------------------------------------------------------------
// Rewrap helpers
// ---------------------------------------------------------------------------

/// Re-wrap the DEK with a new PIN (e.g. on PIN change).
pub fn rewrap_pin(
    row: &mut KeywrapRow,
    dek: &[u8; 32],
    new_pin: &str,
) -> Result<(), crate::AppError> {
    let params: KdfParams = serde_json::from_slice(&row.pin_params)
        .map_err(|e| crate::AppError::Crypto(format!("bad pin_params: {e}")))?;

    let mut new_kek = derive_pin_kek(new_pin, &row.pin_salt, &params)
        .map_err(|e| crate::AppError::Crypto(e.to_string()))?;

    let new_wrapped = wrap_dek(dek, &new_kek)
        .map_err(|e| crate::AppError::Crypto(e.to_string()))?;

    kdf::zeroize_key(&mut new_kek);

    row.pin_wrapped_dek = new_wrapped;
    row.updated_at = now_unix();
    Ok(())
}

/// Re-wrap the DEK with a new recovery passphrase.
pub fn rewrap_recovery(
    row: &mut KeywrapRow,
    dek: &[u8; 32],
    new_passphrase: &str,
) -> Result<(), crate::AppError> {
    let params: KdfParams = serde_json::from_slice(&row.rec_params)
        .map_err(|e| crate::AppError::Crypto(format!("bad rec_params: {e}")))?;

    let mut new_kek = derive_pin_kek(new_passphrase, &row.rec_salt, &params)
        .map_err(|e| crate::AppError::Crypto(e.to_string()))?;

    let new_wrapped = wrap_dek(dek, &new_kek)
        .map_err(|e| crate::AppError::Crypto(e.to_string()))?;

    kdf::zeroize_key(&mut new_kek);

    row.rec_wrapped_dek = new_wrapped;
    row.updated_at = now_unix();
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::kdf::{random_dek, random_salt, KEK_LEN};

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(KEYSTORE_SCHEMA).unwrap();
        conn
    }

    fn make_row(
        pin: &str,
        passphrase: &str,
        dek: &[u8; KEK_LEN],
    ) -> KeywrapRow {
        let pin_salt = random_salt().to_vec();
        let rec_salt = random_salt().to_vec();
        let backup_salt = random_salt().to_vec();
        let pin_params = serde_json::to_vec(&KdfParams::PIN).unwrap();
        let rec_params = serde_json::to_vec(&KdfParams::RECOVERY).unwrap();

        let mut pin_kek = derive_pin_kek(pin, &pin_salt, &KdfParams::PIN).unwrap();
        let mut rec_kek = derive_pin_kek(passphrase, &rec_salt, &KdfParams::RECOVERY).unwrap();

        let pin_wrapped_dek = wrap_dek(dek, &pin_kek).unwrap();
        let rec_wrapped_dek = wrap_dek(dek, &rec_kek).unwrap();

        kdf::zeroize_key(&mut pin_kek);
        kdf::zeroize_key(&mut rec_kek);

        let ts = now_unix();
        KeywrapRow {
            id: 1,
            pin_salt,
            pin_params,
            pin_wrapped_dek,
            rec_salt,
            rec_params,
            rec_wrapped_dek,
            backup_salt,
            version: 1,
            created_at: ts,
            updated_at: ts,
        }
    }

    #[test]
    fn test_rewrap_roundtrip() {
        let conn = setup_test_db();
        let dek = random_dek();
        let pin = "123456";

        let mut row = make_row(pin, "some-long-recovery-phrase", &dek);
        write_initial(&conn, &row).unwrap();

        // Unwrap with original PIN.
        let dek1 = unwrap_with_pin(&row, pin).unwrap();
        assert_eq!(*dek1, dek);

        // Rewrap with new PIN.
        rewrap_pin(&mut row, &dek, "999999").unwrap();
        update(&conn, &row).unwrap();

        // Unwrap with new PIN.
        let dek2 = unwrap_with_pin(&row, "999999").unwrap();
        assert_eq!(*dek2, dek);

        // Old PIN should now fail.
        assert!(unwrap_with_pin(&row, pin).is_err());
    }

    #[test]
    fn test_pin_and_recovery_yield_same_dek() {
        let conn = setup_test_db();
        let dek = random_dek();
        let pin = "123456";
        let passphrase = "correct horse battery staple";

        let row = make_row(pin, passphrase, &dek);
        write_initial(&conn, &row).unwrap();

        let from_pin = unwrap_with_pin(&row, pin).unwrap();
        let from_rec = unwrap_with_recovery(&row, passphrase).unwrap();

        assert_eq!(*from_pin, *from_rec);
        assert_eq!(*from_pin, dek);
    }

    #[test]
    fn test_backup_key_derivation_is_deterministic() {
        let conn = setup_test_db();
        let dek = random_dek();
        let passphrase = "correct horse battery staple";

        let row = make_row("123456", passphrase, &dek);
        write_initial(&conn, &row).unwrap();

        let k1 = derive_backup_key(&row, passphrase).unwrap();
        let k2 = derive_backup_key(&row, passphrase).unwrap();
        assert_eq!(*k1, *k2);
        // Backup key must differ from the DEK itself.
        assert_ne!(*k1, dek);
    }

    #[test]
    fn test_backup_salt_persists() {
        let conn = setup_test_db();
        let dek = random_dek();
        let row = make_row("123456", "long-passphrase", &dek);
        let original_backup_salt = row.backup_salt.clone();
        write_initial(&conn, &row).unwrap();

        let read_back = read(&conn).unwrap();
        assert_eq!(read_back.backup_salt, original_backup_salt);
        assert_eq!(read_back.backup_salt.len(), 16); // spec §4.1: 16-byte salts
    }

    #[test]
    fn test_wrong_passphrase_returns_wrong_pin() {
        let conn = setup_test_db();
        let dek = random_dek();
        let row = make_row("123456", "long-passphrase", &dek);
        write_initial(&conn, &row).unwrap();

        match unwrap_with_pin(&row, "000000") {
            Err(crate::AppError::WrongPin) => {} // expected
            other => panic!("expected WrongPin, got {:?}", other),
        }
    }

    #[test]
    fn test_upsert_overwrites_existing_row() {
        let conn = setup_test_db();
        let dek = random_dek();
        let row = make_row("123456", "long-passphrase", &dek);
        write_initial(&conn, &row).unwrap();

        let mut updated = row.clone();
        updated.updated_at += 1;
        let mutated_backup_salt = vec![0u8; 16];
        updated.backup_salt = mutated_backup_salt.clone();
        upsert(&conn, &updated).unwrap();

        let read_back = read(&conn).unwrap();
        assert_eq!(read_back.backup_salt, mutated_backup_salt);
        assert_eq!(read_back.updated_at, updated.updated_at);
    }

    #[test]
    fn test_lockout_read_write_clear() {
        let conn = setup_test_db();
        let row = LockoutRow {
            user_id: 1,
            failed_attempts: 3,
            locked_until: Some(1234567890),
            wipe_on_next_fail: true,
            action: "timeout".to_string(),
            base_minutes: 15,
        };
        write_lockout(&conn, &row).unwrap();

        let read_back = read_lockout(&conn, 1).unwrap();
        assert_eq!(read_back.failed_attempts, 3);
        assert_eq!(read_back.locked_until, Some(1234567890));
        assert!(read_back.wipe_on_next_fail);

        clear_lockout(&conn, 1).unwrap();
        assert!(matches!(
            read_lockout(&conn, 1),
            Err(rusqlite::Error::QueryReturnedNoRows)
        ));
    }
}

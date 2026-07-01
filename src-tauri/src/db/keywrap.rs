//! Reads and writes the `keywrap` rows, and provides DEK
//! wrapping/unwrapping via the [`crypto`] module.
//!
//! The keywrap rows live in a separate unencrypted SQLite sidecar file
//! (`<db_path>.keystore`) so they can be read without the DEK — needed to
//! bootstrap `unlock`. See `commands::auth::open_keystore` for the file
//! location and `KEYSTORE_SCHEMA` for the table DDL.
//!
//! PDE (Plausible Deniability Encryption) extends the schema to 3 rows:
//! - id=1 / role='real'   → owner's real PIN wraps DEK_real
//! - id=2 / role='decoy'  → decoy PIN wraps DEK_decoy
//! - id=3 / role='duress' → duress PIN wraps DEK_decoy (same DEK as decoy)

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::crypto::kdf::{self, derive_pin_kek, KdfParams};
use crate::crypto::wrap::{unwrap_dek, wrap_dek};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PinRole {
    Real,
    Decoy,
    Duress,
}

impl PinRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            PinRole::Real => "real",
            PinRole::Decoy => "decoy",
            PinRole::Duress => "duress",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "real" => Some(PinRole::Real),
            "decoy" => Some(PinRole::Decoy),
            "duress" => Some(PinRole::Duress),
            _ => None,
        }
    }

    pub fn row_id(&self) -> i64 {
        match self {
            PinRole::Real => 1,
            PinRole::Decoy => 2,
            PinRole::Duress => 3,
        }
    }
}

// ---------------------------------------------------------------------------
// Schema (shared between production `open_keystore` and tests)
// ---------------------------------------------------------------------------

/// DDL for the unencrypted keywrap sidecar DB. Supports up to 3 rows for PDE
/// (real/decoy/duress), plus a `lockouts` table so lockout state can be read
/// before the main DB is unlocked.
pub const KEYSTORE_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS keywrap (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'real',
  pin_salt BLOB NOT NULL,
  pin_params BLOB NOT NULL,
  pin_wrapped_dek BLOB NOT NULL,
  pin_verifier BLOB NOT NULL DEFAULT X'',
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
  base_minutes INTEGER NOT NULL DEFAULT 15,
  deception_mode INTEGER NOT NULL DEFAULT 0
);";

/// Migrate an existing single-row keywrap table (pre-PDE) to the new schema
/// with `role` and `pin_verifier` columns. Idempotent: no-op if already migrated.
pub fn migrate_keystore_schema(conn: &Connection) -> Result<(), rusqlite::Error> {
    let has_role = conn.prepare("SELECT role FROM keywrap LIMIT 0").is_ok();

    if has_role {
        return Ok(());
    }

    conn.execute_batch(
        "ALTER TABLE keywrap RENAME TO keywrap_legacy;
         CREATE TABLE keywrap (
           id INTEGER PRIMARY KEY,
           role TEXT NOT NULL DEFAULT 'real',
           pin_salt BLOB NOT NULL,
           pin_params BLOB NOT NULL,
           pin_wrapped_dek BLOB NOT NULL,
           pin_verifier BLOB NOT NULL DEFAULT X'',
           rec_salt BLOB NOT NULL,
           rec_params BLOB NOT NULL,
           rec_wrapped_dek BLOB NOT NULL,
           backup_salt BLOB NOT NULL,
           version INTEGER NOT NULL DEFAULT 1,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         INSERT INTO keywrap (id, role, pin_salt, pin_params, pin_wrapped_dek, pin_verifier,
           rec_salt, rec_params, rec_wrapped_dek, backup_salt, version, created_at, updated_at)
         SELECT id, 'real', pin_salt, pin_params, pin_wrapped_dek, X'',
           rec_salt, rec_params, rec_wrapped_dek, backup_salt, version, created_at, updated_at
         FROM keywrap_legacy;
         DROP TABLE keywrap_legacy;",
    )?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

/// Mirrors the `keywrap` table row.
///
/// Column naming is internal to the keywrap layer; the operational location
/// is the sidecar `<db_path>.keystore` file, not the encrypted main DB.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeywrapRow {
    pub id: i64,
    pub role: PinRole,
    pub pin_salt: Vec<u8>,
    pub pin_params: Vec<u8>,
    pub pin_wrapped_dek: Vec<u8>,
    /// SHA-256(KEK) for fast PIN verification without AES-GCM unwrap.
    pub pin_verifier: Vec<u8>,
    pub rec_salt: Vec<u8>,
    pub rec_params: Vec<u8>,
    pub rec_wrapped_dek: Vec<u8>,
    /// Salt for backup-key derivation (decision 0.14).
    pub backup_salt: Vec<u8>,
    pub version: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Compute the pin_verifier = SHA-256(KEK) for a derived KEK.
pub fn pin_verifier_for_kek(kek: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(kek);
    let result = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&result);
    out
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
    /// v2 column: 1 once the owner has hit `commands::auth::DECEPTION_THRESHOLD`
    /// wrong PINs. Future unlocks short-circuit to a decoy session until reset.
    #[serde(default)]
    pub deception_mode: i64,
}

// ---------------------------------------------------------------------------
// CRUD helpers
// ---------------------------------------------------------------------------

fn row_from_stmt(r: &rusqlite::Row) -> Result<KeywrapRow, rusqlite::Error> {
    let role_str: String = r.get(1)?;
    let role = PinRole::from_str(&role_str).ok_or_else(|| {
        rusqlite::Error::InvalidParameterName(format!("unknown pin role: {role_str}"))
    })?;
    Ok(KeywrapRow {
        id: r.get(0)?,
        role,
        pin_salt: r.get(2)?,
        pin_params: r.get(3)?,
        pin_wrapped_dek: r.get(4)?,
        pin_verifier: r.get(5)?,
        rec_salt: r.get(6)?,
        rec_params: r.get(7)?,
        rec_wrapped_dek: r.get(8)?,
        backup_salt: r.get(9)?,
        version: r.get(10)?,
        created_at: r.get(11)?,
        updated_at: r.get(12)?,
    })
}

/// Read the real (id=1) keywrap row. Backward-compatible with pre-PDE schema.
pub fn read(conn: &Connection) -> Result<KeywrapRow, crate::AppError> {
    let mut stmt = conn.prepare(
        "SELECT id, role, pin_salt, pin_params, pin_wrapped_dek, pin_verifier,
         rec_salt, rec_params, rec_wrapped_dek, backup_salt,
         version, created_at, updated_at
         FROM keywrap WHERE id = 1",
    )?;

    let row = stmt.query_row([], row_from_stmt).map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => crate::AppError::NoKeywrap,
        other => crate::AppError::Db(other),
    })?;

    Ok(row)
}

/// Read a keywrap row by its PDE role.
pub fn read_by_role(conn: &Connection, role: PinRole) -> Result<KeywrapRow, crate::AppError> {
    let mut stmt = conn.prepare(
        "SELECT id, role, pin_salt, pin_params, pin_wrapped_dek, pin_verifier,
         rec_salt, rec_params, rec_wrapped_dek, backup_salt,
         version, created_at, updated_at
         FROM keywrap WHERE role = ?1",
    )?;

    stmt.query_row([role.as_str()], row_from_stmt)
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => crate::AppError::NoKeywrap,
            other => crate::AppError::Db(other),
        })
}

/// Read all keywrap rows (up to 3 for PDE). Returns all rows found.
pub fn read_all(conn: &Connection) -> Result<Vec<KeywrapRow>, crate::AppError> {
    let mut stmt = conn.prepare(
        "SELECT id, role, pin_salt, pin_params, pin_wrapped_dek, pin_verifier,
         rec_salt, rec_params, rec_wrapped_dek, backup_salt,
         version, created_at, updated_at
         FROM keywrap ORDER BY id",
    )?;

    let rows = stmt
        .query_map([], row_from_stmt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(crate::AppError::Db)?;

    Ok(rows)
}

/// Insert the initial keywrap row (INSERT OR IGNORE for safety).
pub fn write_initial(conn: &Connection, row: &KeywrapRow) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT OR IGNORE INTO keywrap \
         (id, role, pin_salt, pin_params, pin_wrapped_dek, pin_verifier, \
          rec_salt, rec_params, rec_wrapped_dek, backup_salt, \
          version, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        rusqlite::params![
            row.id,
            row.role.as_str(),
            &row.pin_salt,
            &row.pin_params,
            &row.pin_wrapped_dek,
            &row.pin_verifier,
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

/// Update the existing keywrap row by id.
pub fn update(conn: &Connection, row: &KeywrapRow) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE keywrap SET \
         role = ?1, pin_salt = ?2, pin_params = ?3, pin_wrapped_dek = ?4, \
         pin_verifier = ?5, rec_salt = ?6, rec_params = ?7, rec_wrapped_dek = ?8, \
         backup_salt = ?9, version = ?10, updated_at = ?11 \
         WHERE id = ?12",
        rusqlite::params![
            row.role.as_str(),
            &row.pin_salt,
            &row.pin_params,
            &row.pin_wrapped_dek,
            &row.pin_verifier,
            &row.rec_salt,
            &row.rec_params,
            &row.rec_wrapped_dek,
            &row.backup_salt,
            row.version,
            row.updated_at,
            row.id,
        ],
    )?;
    Ok(())
}

/// Upsert a keywrap row by id. This is the production write path used
/// by PIN change, recovery passphrase change, and PDE provisioning.
pub fn upsert(conn: &Connection, row: &KeywrapRow) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO keywrap \
         (id, role, pin_salt, pin_params, pin_wrapped_dek, pin_verifier, \
          rec_salt, rec_params, rec_wrapped_dek, backup_salt, \
          version, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) \
         ON CONFLICT(id) DO UPDATE SET \
           role = excluded.role, \
           pin_salt = excluded.pin_salt, \
           pin_params = excluded.pin_params, \
           pin_wrapped_dek = excluded.pin_wrapped_dek, \
           pin_verifier = excluded.pin_verifier, \
           rec_salt = excluded.rec_salt, \
           rec_params = excluded.rec_params, \
           rec_wrapped_dek = excluded.rec_wrapped_dek, \
           backup_salt = excluded.backup_salt, \
           version = excluded.version, \
           updated_at = excluded.updated_at",
        params![
            row.id,
            row.role.as_str(),
            &row.pin_salt,
            &row.pin_params,
            &row.pin_wrapped_dek,
            &row.pin_verifier,
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

/// Delete a keywrap row by role.
pub fn delete_by_role(conn: &Connection, role: PinRole) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM keywrap WHERE role = ?1", [role.as_str()])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Lockout helpers
// ---------------------------------------------------------------------------

/// Read the lockout row for `user_id` from the sidecar.
pub fn read_lockout(conn: &Connection, user_id: i64) -> Result<LockoutRow, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT user_id, failed_attempts, locked_until, wipe_on_next_fail, action, base_minutes, deception_mode \
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
            deception_mode: r.get::<_, i64>(6).unwrap_or(0),
        })
    })
}

/// Upsert a lockout row.
pub fn write_lockout(conn: &Connection, row: &LockoutRow) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO lockouts (user_id, failed_attempts, locked_until, wipe_on_next_fail, action, base_minutes, deception_mode) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
         ON CONFLICT(user_id) DO UPDATE SET \
           failed_attempts = excluded.failed_attempts, \
           locked_until = excluded.locked_until, \
           wipe_on_next_fail = excluded.wipe_on_next_fail, \
           action = excluded.action, \
           base_minutes = excluded.base_minutes, \
           deception_mode = excluded.deception_mode",
        params![
            row.user_id,
            row.failed_attempts,
            row.locked_until,
            row.wipe_on_next_fail as i64,
            row.action,
            row.base_minutes,
            row.deception_mode,
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
pub fn unwrap_with_pin(
    row: &KeywrapRow,
    pin: &str,
) -> Result<Zeroizing<[u8; 32]>, crate::AppError> {
    let params: KdfParams = serde_json::from_slice(&row.pin_params)
        .map_err(|e| crate::AppError::Crypto(format!("bad pin_params: {e}")))?;

    let mut kek = derive_pin_kek(pin, &row.pin_salt, &params)
        .map_err(|e| crate::AppError::Crypto(e.to_string()))?;

    let dek = unwrap_dek(&row.pin_wrapped_dek, &kek).map_err(|_| crate::AppError::WrongPin)?;

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
        .map_err(|_| crate::AppError::WrongRecoveryPassphrase)?;

    kdf::zeroize_key(&mut kek);
    Ok(Zeroizing::new(dek))
}

/// Derive the backup encryption key from the recovery passphrase and stored
/// backup salt. Per decision 0.14: `Argon2id(recovery_passphrase, backup_salt)`
/// using the recovery params (256 MiB / t=3 / p=1).
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

    let new_wrapped =
        wrap_dek(dek, &new_kek).map_err(|e| crate::AppError::Crypto(e.to_string()))?;

    row.pin_verifier = pin_verifier_for_kek(&new_kek).to_vec();
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

    let new_wrapped =
        wrap_dek(dek, &new_kek).map_err(|e| crate::AppError::Crypto(e.to_string()))?;

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

    fn make_row(pin: &str, passphrase: &str, dek: &[u8; KEK_LEN]) -> KeywrapRow {
        let pin_salt = random_salt().to_vec();
        let rec_salt = random_salt().to_vec();
        let backup_salt = random_salt().to_vec();
        let pin_params = serde_json::to_vec(&KdfParams::PIN).unwrap();
        let rec_params = serde_json::to_vec(&KdfParams::RECOVERY).unwrap();

        let mut pin_kek = derive_pin_kek(pin, &pin_salt, &KdfParams::PIN).unwrap();
        let mut rec_kek = derive_pin_kek(passphrase, &rec_salt, &KdfParams::RECOVERY).unwrap();

        let pin_wrapped_dek = wrap_dek(dek, &pin_kek).unwrap();
        let rec_wrapped_dek = wrap_dek(dek, &rec_kek).unwrap();

        let verifier = pin_verifier_for_kek(&pin_kek).to_vec();

        kdf::zeroize_key(&mut pin_kek);
        kdf::zeroize_key(&mut rec_kek);

        let ts = now_unix();
        KeywrapRow {
            id: 1,
            role: PinRole::Real,
            pin_salt,
            pin_params,
            pin_wrapped_dek,
            pin_verifier: verifier,
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

        let dek1 = unwrap_with_pin(&row, pin).unwrap();
        assert_eq!(*dek1, dek);

        rewrap_pin(&mut row, &dek, "999999").unwrap();
        update(&conn, &row).unwrap();

        let dek2 = unwrap_with_pin(&row, "999999").unwrap();
        assert_eq!(*dek2, dek);

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
        assert_eq!(read_back.backup_salt.len(), 32);
    }

    #[test]
    fn test_wrong_passphrase_returns_wrong_pin() {
        let conn = setup_test_db();
        let dek = random_dek();
        let row = make_row("123456", "long-passphrase", &dek);
        write_initial(&conn, &row).unwrap();

        match unwrap_with_pin(&row, "000000") {
            Err(crate::AppError::WrongPin) => {}
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
        let mutated_backup_salt = vec![0u8; 32];
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
            deception_mode: 0,
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

    #[test]
    fn test_pde_three_rows() {
        let conn = setup_test_db();
        let dek_real = random_dek();
        let dek_decoy = random_dek();
        let ts = now_unix();

        let pin_salt = random_salt().to_vec();
        let rec_salt = random_salt().to_vec();
        let backup_salt = random_salt().to_vec();
        let pin_params = serde_json::to_vec(&KdfParams::PIN).unwrap();
        let rec_params = serde_json::to_vec(&KdfParams::RECOVERY).unwrap();

        let mut pin_kek = derive_pin_kek("111111", &pin_salt, &KdfParams::PIN).unwrap();
        let rec_kek_real =
            derive_pin_kek("recovery-real", &rec_salt, &KdfParams::RECOVERY).unwrap();
        let real_row = KeywrapRow {
            id: 1,
            role: PinRole::Real,
            pin_salt: pin_salt.clone(),
            pin_params: pin_params.clone(),
            pin_wrapped_dek: wrap_dek(&dek_real, &pin_kek).unwrap(),
            pin_verifier: pin_verifier_for_kek(&pin_kek).to_vec(),
            rec_salt: rec_salt.clone(),
            rec_params: rec_params.clone(),
            rec_wrapped_dek: wrap_dek(&dek_real, &rec_kek_real).unwrap(),
            backup_salt: backup_salt.clone(),
            version: 1,
            created_at: ts,
            updated_at: ts,
        };
        kdf::zeroize_key(&mut pin_kek);

        let mut pin_kek_d = derive_pin_kek("222222", &pin_salt, &KdfParams::PIN).unwrap();
        let rec_kek_decoy =
            derive_pin_kek("recovery-decoy", &rec_salt, &KdfParams::RECOVERY).unwrap();
        let decoy_row = KeywrapRow {
            id: 2,
            role: PinRole::Decoy,
            pin_salt: pin_salt.clone(),
            pin_params: pin_params.clone(),
            pin_wrapped_dek: wrap_dek(&dek_decoy, &pin_kek_d).unwrap(),
            pin_verifier: pin_verifier_for_kek(&pin_kek_d).to_vec(),
            rec_salt: rec_salt.clone(),
            rec_params: rec_params.clone(),
            rec_wrapped_dek: wrap_dek(&dek_decoy, &rec_kek_decoy).unwrap(),
            backup_salt: backup_salt.clone(),
            version: 1,
            created_at: ts,
            updated_at: ts,
        };
        kdf::zeroize_key(&mut pin_kek_d);

        upsert(&conn, &real_row).unwrap();
        upsert(&conn, &decoy_row).unwrap();

        let duress_row = KeywrapRow {
            id: 3,
            role: PinRole::Duress,
            pin_salt: pin_salt.clone(),
            pin_params: pin_params.clone(),
            pin_wrapped_dek: decoy_row.pin_wrapped_dek.clone(),
            pin_verifier: decoy_row.pin_verifier.clone(),
            rec_salt: rec_salt.clone(),
            rec_params: rec_params.clone(),
            rec_wrapped_dek: decoy_row.rec_wrapped_dek.clone(),
            backup_salt: backup_salt.clone(),
            version: 1,
            created_at: ts,
            updated_at: ts,
        };
        upsert(&conn, &duress_row).unwrap();

        let all = read_all(&conn).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].role, PinRole::Real);
        assert_eq!(all[1].role, PinRole::Decoy);
        assert_eq!(all[2].role, PinRole::Duress);

        let real_back = read_by_role(&conn, PinRole::Real).unwrap();
        assert_eq!(*unwrap_with_pin(&real_back, "111111").unwrap(), dek_real);

        let decoy_back = read_by_role(&conn, PinRole::Decoy).unwrap();
        assert_eq!(*unwrap_with_pin(&decoy_back, "222222").unwrap(), dek_decoy);

        let duress_back = read_by_role(&conn, PinRole::Duress).unwrap();
        assert_eq!(*unwrap_with_pin(&duress_back, "222222").unwrap(), dek_decoy);
    }

    #[test]
    fn test_migration_from_legacy_schema() {
        let conn = Connection::open_in_memory().unwrap();
        // Create the old schema (pre-PDE).
        conn.execute_batch(
            "CREATE TABLE keywrap (
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
             );",
        )
        .unwrap();

        let dek = random_dek();
        let pin_salt = random_salt().to_vec();
        let rec_salt = random_salt().to_vec();
        let backup_salt = random_salt().to_vec();
        let pin_params = serde_json::to_vec(&KdfParams::PIN).unwrap();
        let rec_params = serde_json::to_vec(&KdfParams::RECOVERY).unwrap();
        let mut pin_kek = derive_pin_kek("123456", &pin_salt, &KdfParams::PIN).unwrap();
        let mut rec_kek = derive_pin_kek("passphrase", &rec_salt, &KdfParams::RECOVERY).unwrap();
        let pin_wrapped = wrap_dek(&dek, &pin_kek).unwrap();
        let rec_wrapped = wrap_dek(&dek, &rec_kek).unwrap();
        kdf::zeroize_key(&mut pin_kek);
        kdf::zeroize_key(&mut rec_kek);

        conn.execute(
            "INSERT INTO keywrap (id, pin_salt, pin_params, pin_wrapped_dek,
             rec_salt, rec_params, rec_wrapped_dek, backup_salt, version, created_at, updated_at)
             VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, 1000, 1000)",
            rusqlite::params![
                pin_salt,
                pin_params,
                pin_wrapped,
                rec_salt,
                rec_params,
                rec_wrapped,
                backup_salt
            ],
        )
        .unwrap();

        // Verify old schema can't have role column.
        assert!(conn
            .execute("SELECT role FROM keywrap LIMIT 0", [])
            .is_err());

        // Run migration.
        migrate_keystore_schema(&conn).unwrap();

        // Verify new schema.
        let row = read(&conn).unwrap();
        assert_eq!(row.id, 1);
        assert_eq!(row.role, PinRole::Real);
        assert!(
            row.pin_verifier.is_empty(),
            "legacy migration leaves pin_verifier empty"
        );
        assert_eq!(row.pin_salt, pin_salt);

        // Idempotent: running again is a no-op.
        migrate_keystore_schema(&conn).unwrap();
        let row2 = read(&conn).unwrap();
        assert_eq!(row2.role, PinRole::Real);
    }

    #[test]
    fn test_pin_verifier_matches_derived_kek() {
        let kek = [42u8; 32];
        let v1 = pin_verifier_for_kek(&kek);
        let v2 = pin_verifier_for_kek(&kek);
        assert_eq!(v1, v2);
        assert_eq!(v1.len(), 32);

        let kek2 = [43u8; 32];
        let v3 = pin_verifier_for_kek(&kek2);
        assert_ne!(v1, v3);
    }
}

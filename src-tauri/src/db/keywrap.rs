//! Reads and writes the `keywrap` singleton row, and provides DEK
//! wrapping/unwrapping via the [`crypto`] module.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::crypto::kdf::{self, derive_pin_kek, KdfParams};
use crate::crypto::wrap::{unwrap_dek, wrap_dek};

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

/// Mirrors the `keywrap` table row (id = 1).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeywrapRow {
    pub id: i64,
    pub pin_salt: Vec<u8>,
    pub pin_params: Vec<u8>,
    pub pin_wrapped_dek: Vec<u8>,
    pub rec_salt: Vec<u8>,
    pub rec_params: Vec<u8>,
    pub rec_wrapped_dek: Vec<u8>,
    pub version: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

// ---------------------------------------------------------------------------
// CRUD helpers
// ---------------------------------------------------------------------------

/// Read the singleton keywrap row.
pub fn read(conn: &Connection) -> Result<KeywrapRow, crate::AppError> {
    let mut stmt = conn.prepare(
        "SELECT id, pin_salt, pin_params, pin_wrapped_dek, \
         rec_salt, rec_params, rec_wrapped_dek, version, \
         created_at, updated_at \
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
                version: r.get(7)?,
                created_at: r.get(8)?,
                updated_at: r.get(9)?,
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
          rec_salt, rec_params, rec_wrapped_dek, version, \
          created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![
            1i64,
            &row.pin_salt,
            &row.pin_params,
            &row.pin_wrapped_dek,
            &row.rec_salt,
            &row.rec_params,
            &row.rec_wrapped_dek,
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
         version = ?7, updated_at = ?8 \
         WHERE id = 1",
        rusqlite::params![
            &row.pin_salt,
            &row.pin_params,
            &row.pin_wrapped_dek,
            &row.rec_salt,
            &row.rec_params,
            &row.rec_wrapped_dek,
            row.version,
            row.updated_at,
        ],
    )?;
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
    use rusqlite::Connection;

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA key = 'test';").unwrap();
        // We need at least the keywrap table for these tests.
        conn.execute_batch(include_str!("schema_v1.sql")).unwrap();
        conn
    }

    fn make_row(
        pin: &str,
        passphrase: &str,
        dek: &[u8; KEK_LEN],
    ) -> KeywrapRow {
        let pin_salt = random_salt().to_vec();
        let rec_salt = random_salt().to_vec();
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
}

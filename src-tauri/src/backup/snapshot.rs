//! SQLite snapshot via the `rusqlite::Connection::backup` API.
//!
//! In M1 the live database lives at the OS-specific data dir. This module
//! takes a snapshot by opening the source and asking SQLite to copy its
//! pages to a destination file. The destination is a temporary plaintext
//! SQLCipher DB which is then encrypted by `crate::backup::encrypt_snapshot`.

use std::path::Path;

use rusqlite::backup::Backup;

use crate::backup::{BackupError, BackupResult};

/// Snapshot the SQLite database at `src` to `dest` using the rusqlite backup
/// API. `dek` is reserved for the Slice A path that opens the source with a
/// SQLCipher key; in M1 we open unencrypted or with the default key.
pub fn snapshot_via_backup_api(
    src: &Path,
    dek: Option<&[u8; 32]>,
    dest: &Path,
) -> BackupResult<()> {
    if !src.exists() {
        return Err(BackupError::Other(format!(
            "source DB not found: {}",
            src.display()
        )));
    }

    // TODO(slice-A): when Slice A's `Db` lands, accept a typed handle and
    // route through `Db::with_conn` so the DEK in RAM is used as the SQLCipher
    // key. For M1 we open the file directly.
    let src_conn = rusqlite::Connection::open(src)?;
    if let Some(_dek) = dek {
        // Placeholder for the SQLCipher PRAGMA key path. Slice A wires the
        // real call once the typed Db is available.
    }

    let mut dst_conn = rusqlite::Connection::open(dest)?;
    {
        let backup = Backup::new(&src_conn, &mut dst_conn)?;
        backup.run_to_completion(50, std::time::Duration::from_millis(50), None)?;
    }
    Ok(())
}

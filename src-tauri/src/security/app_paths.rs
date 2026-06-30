//! Deterministic per-machine opaque path names.
//!
//! Every file the app creates on disk uses a name derived from:
//!
//!   SHA-256(APP_ENTROPY ‖ machine_id ‖ purpose) → first 6 bytes → 12 hex chars
//!
//! Result: files look like `a7f3c291d2e4.db`, `.c8f1a3/`, `b4e9-20240101.pkb1`.
//! A forensic analyst sees only hex-named blobs — no indication of which is the
//! database, which is the keystore, or which directory holds security snapshots.
//!
//! The mapping is implicit: re-run the same derivation → same name. No index
//! file is needed.
//!
//! # Migration
//! Call [`migrate_legacy_names`] once at startup to rename any pre-existing
//! plaintext files (`paintkiduakan.db`, `session.log`, etc.) to their derived
//! counterparts. The rename is best-effort and idempotent.

use sha2::{Digest, Sha256};
use std::sync::OnceLock;

// ─── Machine ID ────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn platform_machine_id() -> String {
    extern "C" {
        fn sysctlbyname(
            name: *const u8,
            oldp: *mut u8,
            oldlenp: *mut usize,
            newp: *const u8,
            newlen: usize,
        ) -> i32;
    }
    let name = b"kern.uuid\0";
    let mut buf = vec![0u8; 64];
    let mut len = buf.len();
    let ret = unsafe {
        sysctlbyname(name.as_ptr(), buf.as_mut_ptr(), &mut len, std::ptr::null(), 0)
    };
    if ret != 0 {
        return String::new();
    }
    while buf.last() == Some(&0) {
        buf.pop();
    }
    String::from_utf8(buf).unwrap_or_default()
}

#[cfg(target_os = "windows")]
fn platform_machine_id() -> String {
    // Registry: HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid
    // Fall back to COMPUTERNAME which is stable per-machine.
    std::env::var("COMPUTERNAME").unwrap_or_default()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_machine_id() -> String {
    std::fs::read_to_string("/etc/machine-id")
        .or_else(|_| std::fs::read_to_string("/proc/sys/kernel/random/boot_id"))
        .unwrap_or_default()
        .trim()
        .to_string()
}

// ─── Core derivation ───────────────────────────────────────────────────────

/// Derive 12 opaque hex chars for `purpose` using APP_ENTROPY + machine_id.
/// Identical inputs always produce the same output; different machines produce
/// different outputs (assuming non-empty machine IDs).
fn derive(purpose: &str) -> String {
    // obfstr! keeps the entropy constant out of .rodata.
    let entropy = crate::obfstr!("paintkiduakan-master.keystore.v1");
    let mid = platform_machine_id();
    let mut sha = Sha256::new();
    sha.update(&entropy);
    sha.update(mid.as_bytes());
    sha.update(purpose.as_bytes());
    let d = sha.finalize();
    d[..6].iter().map(|b| format!("{b:02x}")).collect()
}

// ─── OnceLock-cached getters ───────────────────────────────────────────────

static DB_NAME: OnceLock<String> = OnceLock::new();
static KS_EXT: OnceLock<String> = OnceLock::new();
static SNAP_DIR: OnceLock<String> = OnceLock::new();
static SNAP_PFX: OnceLock<String> = OnceLock::new();
static LOG_NAME: OnceLock<String> = OnceLock::new();

/// Main encrypted database filename. Example: `a7f3c291d2e4.db`
pub fn db_name() -> &'static str {
    DB_NAME.get_or_init(|| format!("{}.db", derive("main")))
}

/// Keystore sidecar extension (without dot). Example: `b4e9d052c1f3`
pub fn ks_ext() -> &'static str {
    KS_EXT.get_or_init(|| derive("ks"))
}

/// Hidden directory for pre-wipe snapshots. Example: `.c8f1a3`
pub fn snap_dir() -> &'static str {
    SNAP_DIR.get_or_init(|| {
        let h = derive("store");
        format!(".{}", &h[..6])
    })
}

/// Filename prefix for pre-wipe snapshots. Example: `d2e4b1`
pub fn snap_prefix() -> &'static str {
    SNAP_PFX.get_or_init(|| {
        let h = derive("snap");
        h[..6].to_string()
    })
}

/// Session log filename. Example: `f9a2c847e1b0.log`
pub fn log_name() -> &'static str {
    LOG_NAME.get_or_init(|| format!("{}.log", derive("log")))
}

// ─── One-time migration ────────────────────────────────────────────────────

/// Rename any legacy plaintext files to their derived opaque names.
/// Safe to call multiple times (idempotent). Errors are logged and ignored.
pub fn migrate_legacy_names(app_data_dir: &std::path::Path, log_dir: &std::path::Path) {
    // ── Database + keystore ────────────────────────────────────────────────
    let old_db = app_data_dir.join(crate::obs!("paintkiduakan.db"));
    let new_db = app_data_dir.join(db_name());
    if old_db.exists() && !new_db.exists() {
        if let Err(e) = std::fs::rename(&old_db, &new_db) {
            log::warn!("app_paths: db rename failed: {e}");
        } else {
            log::info!("app_paths: migrated db to opaque name");
        }
    }

    // Keystore: old extension "keystore", new extension from ks_ext()
    let old_ks = app_data_dir
        .join(crate::obs!("paintkiduakan.db"))
        .with_extension("keystore");
    let new_ks = new_db.with_extension(ks_ext());
    if old_ks.exists() && !new_ks.exists() {
        if let Err(e) = std::fs::rename(&old_ks, &new_ks) {
            log::warn!("app_paths: keystore rename failed: {e}");
        }
    }

    // WAL / SHM — SQLite names these as `{db_file}-wal` / `{db_file}-shm`.
    for suffix in &["-wal", "-shm"] {
        let old = app_data_dir.join(format!("{}{suffix}", crate::obs!("paintkiduakan.db")));
        let new = app_data_dir.join(format!("{}{suffix}", db_name()));
        if old.exists() && !new.exists() {
            let _ = std::fs::rename(&old, &new);
        }
    }

    // ── Session log ────────────────────────────────────────────────────────
    let old_log = log_dir.join(crate::obs!("session.log"));
    let new_log = log_dir.join(log_name());
    if old_log.exists() && !new_log.exists() {
        if let Err(e) = std::fs::rename(&old_log, &new_log) {
            log::warn!("app_paths: log rename failed: {e}");
        }
    }

    // Rotated log generations: session.log.1 … session.log.3
    for i in 1u32..=3 {
        let old = log_dir.join(format!("{}.{i}", crate::obs!("session.log")));
        let new = log_dir.join(format!("{}.{i}", log_name()));
        if old.exists() && !new.exists() {
            let _ = std::fs::rename(&old, &new);
        }
    }

    // ── Pre-wipe snapshot directory ────────────────────────────────────────
    let old_store = app_data_dir.join(crate::obs!(".store"));
    let new_store = app_data_dir.join(snap_dir());
    if old_store.exists() && !new_store.exists() {
        if let Err(e) = std::fs::rename(&old_store, &new_store) {
            log::warn!("app_paths: snap dir rename failed: {e}");
        }
    }
    // Also migrate from the even-older name used before the .store rename.
    let oldest_store = app_data_dir.join(crate::obs!(".duress_backup"));
    if oldest_store.exists() && !new_store.exists() {
        let _ = std::fs::rename(&oldest_store, &new_store);
    }
}

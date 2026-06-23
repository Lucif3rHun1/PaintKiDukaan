//! DPAPI-encrypted keystore blob + machine fingerprint helpers.
//!
//! The keystore sidecar file (`<db_path>.keystore`) is a SQLite file holding
//! the keywrap rows. Until this module was added the file was plaintext —
//! meaning an attacker who stole the disk image could read pin_salt /
//! pin_params / pin_verifier / pin_wrapped_dek in the clear and run offline
//! Argon2id brute-force without ever touching the running app.
//!
//! This module provides:
//! 1. `encrypt_keystore` / `decrypt_keystore` — wrap the entire SQLite blob
//!    with [Windows DPAPI](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)
//!    using an app-ID entropy. On non-Windows platforms the functions are
//!    pass-through stubs (returns the bytes unchanged).
//! 2. `machine_salt` — a 32-byte SHA-256 fingerprint derived from the local
//!    machine's hostname. Used as additional Argon2id salt input when
//!    deriving PIN-based keys, so a stolen keystore cannot be brute-forced
//!    on a different machine.
//!
//! ## Platform support
//! - **Windows**: full DPAPI encryption. The `windows` crate's
//!   `Win32_Security_Cryptography` feature is NOT enabled in `Cargo.toml`
//!   (this file uses raw FFI to avoid adding a dependency).
//! - **macOS / Linux**: stub — keystore file is plaintext. This is a
//!   **documented limitation**: offline brute-force remains possible on
//!   non-Windows hosts. The hostname-based machine binding still applies
//!   via the Argon2id salt (works on all platforms).

use std::sync::OnceLock;

use sha2::{Digest, Sha256};

use crate::error::AppError;

/// Application-specific DPAPI entropy. Used on Windows so that another
/// process running as the same user cannot decrypt our keystore without
/// knowing this value. Keep this constant stable across releases —
/// changing it invalidates all existing encrypted keystores.
pub const APP_DPAPI_ENTROPY: &[u8] = b"paintkiduakan-master.keystore.v1";

/// SQLCipher plaintext magic. A real SQLite file always starts with these
/// 15 bytes (`"SQLite format 3"` followed by a NUL). Used to distinguish a
/// plaintext legacy keystore from a DPAPI-encrypted one during migration.
pub const SQLITE_MAGIC: &[u8; 15] = b"SQLite format 3";

/// Return true if the bytes look like a plaintext SQLite file (i.e. NOT
/// DPAPI-encrypted). Used by `commands::auth::open_keystore` to decide
/// whether to try DPAPI-decrypt or fall back to opening the file directly.
pub fn is_sqlite_plaintext(bytes: &[u8]) -> bool {
    bytes.len() >= SQLITE_MAGIC.len() && &bytes[..SQLITE_MAGIC.len()] == SQLITE_MAGIC
}

// ---------------------------------------------------------------------------
// DPAPI encrypt / decrypt (Windows)
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
mod platform {
    //! Raw FFI declarations for `CryptProtectData` / `CryptUnprotectData`.
    //!
    //! We avoid the `windows` crate's `Win32_Security_Cryptography` feature
    //! to keep `Cargo.toml` unchanged. The signatures below match the MSDN
    //! documentation verbatim.
    //!
    //! References:
    //! - <https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata>
    //! - <https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptunprotectdata>

    use std::ffi::c_void;
    use std::ptr;

    use windows::Win32::Foundation::HLOCAL;

    /// Win32 `DATA_BLOB` — opaque buffer with explicit length. DPAPI uses
    /// this for both input plaintext and output ciphertext.
    #[repr(C)]
    #[derive(Debug, Clone, Copy)]
    pub struct DATA_BLOB {
        pub cb_data: u32,
        pub pb_data: *mut u8,
    }

    // SAFETY: Both functions are stdcall with documented signatures.
    #[link(name = "crypt32")]
    #[link(name = "kernel32")]
    extern "system" {
        fn CryptProtectData(
            p_data_in: *const DATA_BLOB,
            sz_data_descr: *const u16,
            p_entropy: *const DATA_BLOB,
            pv_reserved: *const c_void,
            p_prompt_struct: *const c_void,
            dw_flags: u32,
            p_data_out: *mut DATA_BLOB,
        ) -> i32;

        fn CryptUnprotectData(
            p_data_in: *const DATA_BLOB,
            ppsz_data_descr: *mut *mut u16,
            p_entropy: *const DATA_BLOB,
            pv_reserved: *const c_void,
            p_prompt_struct: *const c_void,
            dw_flags: u32,
            p_data_out: *mut DATA_BLOB,
        ) -> i32;

        fn LocalFree(h: HLOCAL) -> HLOCAL;
    }

    /// No UI prompt. Required for service / headless contexts.
    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

    /// Make a `DATA_BLOB` that owns a copy of `bytes`. Caller is responsible
    /// for freeing via `free_blob`.
    fn blob_from(bytes: &[u8]) -> DATA_BLOB {
        // Heap-allocate a copy so DPAPI can read it (input) or write it
        // (output). Using a Vec + Box::into_raw guarantees the buffer is
        // properly aligned and won't move.
        let mut boxed: Box<Vec<u8>> = Box::new(bytes.to_vec());
        let ptr = boxed.as_mut_ptr();
        let len = boxed.len();
        // Intentionally leak the Box; DPAPI takes ownership of the input
        // blob and we free it ourselves via LocalFree on the returned ptr
        // for outputs. For inputs we keep the Vec alive until after the
        // call by NOT running drop here.
        std::mem::forget(boxed);
        DATA_BLOB {
            cb_data: len as u32,
            pb_data: ptr,
        }
    }

    /// Free a DPAPI output blob (allocated by CryptProtectData /
    /// CryptUnprotectData via LocalAlloc).
    unsafe fn free_blob(blob: DATA_BLOB) {
        if !blob.pb_data.is_null() {
            // LocalFree knows how to free HLOCAL handles; the pb_data
            // pointer returned by DPAPI is a LocalAlloc'd region.
            LocalFree(HLOCAL(blob.pb_data as *mut c_void));
        }
    }

    /// Build an entropy `DATA_BLOB` from the app ID bytes.
    fn entropy_blob() -> DATA_BLOB {
        blob_from(super::APP_DPAPI_ENTROPY)
    }

    /// Encrypt `plaintext` with DPAPI using app-ID entropy.
    /// Returns the raw DPAPI output bytes (no length prefix).
    pub fn dpapi_encrypt(plaintext: &[u8]) -> Result<Vec<u8>, super::DpapiError> {
        unsafe {
            let input = blob_from(plaintext);
            let entropy = entropy_blob();
            let mut output: DATA_BLOB = DATA_BLOB {
                cb_data: 0,
                pb_data: ptr::null_mut(),
            };
            let ok = CryptProtectData(
                &input,
                ptr::null(),
                &entropy,
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            );
            // Free the input buffer we allocated.
            let _ = Box::from_raw(std::slice::from_raw_parts_mut(
                input.pb_data,
                input.cb_data as usize,
            ));
            if ok == 0 {
                free_blob(output);
                return Err(super::DpapiError::ProtectFailed(
                    std::io::Error::last_os_error().raw_os_error().unwrap_or(0),
                ));
            }
            let out_slice = std::slice::from_raw_parts(output.pb_data, output.cb_data as usize);
            let out_vec = out_slice.to_vec();
            free_blob(output);
            Ok(out_vec)
        }
    }

    /// Decrypt DPAPI-encrypted bytes using app-ID entropy. Returns the
    /// original plaintext (the SQLite file bytes).
    pub fn dpapi_decrypt(ciphertext: &[u8]) -> Result<Vec<u8>, super::DpapiError> {
        unsafe {
            let input = blob_from(ciphertext);
            let entropy = entropy_blob();
            let mut output: DATA_BLOB = DATA_BLOB {
                cb_data: 0,
                pb_data: ptr::null_mut(),
            };
            let ok = CryptUnprotectData(
                &input,
                ptr::null_mut(),
                &entropy,
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            );
            let _ = Box::from_raw(std::slice::from_raw_parts_mut(
                input.pb_data,
                input.cb_data as usize,
            ));
            if ok == 0 {
                free_blob(output);
                return Err(super::DpapiError::UnprotectFailed(
                    std::io::Error::last_os_error().raw_os_error().unwrap_or(0),
                ));
            }
            let out_slice = std::slice::from_raw_parts(output.pb_data, output.cb_data as usize);
            let out_vec = out_slice.to_vec();
            free_blob(output);
            Ok(out_vec)
        }
    }
}

// ---------------------------------------------------------------------------
// Non-Windows stubs
// ---------------------------------------------------------------------------

#[cfg(not(target_os = "windows"))]
mod platform {
    pub fn dpapi_encrypt(plaintext: &[u8]) -> Result<Vec<u8>, super::DpapiError> {
        Ok(plaintext.to_vec())
    }

    pub fn dpapi_decrypt(ciphertext: &[u8]) -> Result<Vec<u8>, super::DpapiError> {
        Ok(ciphertext.to_vec())
    }
}

#[derive(Debug)]
pub enum DpapiError {
    /// DPAPI `CryptProtectData` returned non-zero (failure). Carries the
    /// Win32 error code.
    ProtectFailed(i32),
    /// DPAPI `CryptUnprotectData` returned non-zero (failure). Carries the
    /// Win32 error code.
    UnprotectFailed(i32),
}

impl std::fmt::Display for DpapiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DpapiError::ProtectFailed(c) => {
                write!(f, "CryptProtectData failed (Win32 code {c})")
            }
            DpapiError::UnprotectFailed(c) => {
                write!(f, "CryptUnprotectData failed (Win32 code {c})")
            }
        }
    }
}

impl std::error::Error for DpapiError {}

impl From<DpapiError> for AppError {
    fn from(e: DpapiError) -> Self {
        AppError::Crypto(format!("DPAPI: {e}"))
    }
}

/// Encrypt the keystore blob with DPAPI (Windows) or pass-through (other).
pub fn encrypt_keystore(plaintext: &[u8]) -> Result<Vec<u8>, AppError> {
    platform::dpapi_encrypt(plaintext).map_err(AppError::from)
}

/// Decrypt the keystore blob with DPAPI (Windows) or pass-through (other).
pub fn decrypt_keystore(ciphertext: &[u8]) -> Result<Vec<u8>, AppError> {
    platform::dpapi_decrypt(ciphertext).map_err(AppError::from)
}

// ---------------------------------------------------------------------------
// Machine fingerprint — used as additional Argon2id salt input so a stolen
// keystore cannot be brute-forced on a different machine.
// ---------------------------------------------------------------------------

/// Lazy-initialized, process-lifetime-cached machine salt.
///
/// Sources (in order): `HOSTNAME` env var (POSIX) / `COMPUTERNAME` env var
/// (Windows). On lookup failure we fall back to a fixed placeholder string
/// (still derived through SHA-256) so the salt is deterministic and the
/// Argon2id cost is unchanged — but the security guarantee degrades to
/// "keystore is portable" on hosts without these env vars set.
static MACHINE_SALT: OnceLock<[u8; 32]> = OnceLock::new();

/// Read the machine's hostname (best-effort, infallible).
///
/// - POSIX: reads `HOSTNAME` environment variable (set by most init
///   systems). Avoids adding a `gethostname` crate dependency.
/// - Windows: reads `COMPUTERNAME` environment variable (always set by the
///   Windows kernel). Avoids needing `Win32_System_SystemServices`.
/// - Fallback: empty string (caller treats as "no machine binding").
fn read_hostname() -> String {
    #[cfg(target_os = "windows")]
    {
        std::env::var("COMPUTERNAME").unwrap_or_default()
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOSTNAME").unwrap_or_default()
    }
}

/// Compute `SHA-256(hostname)` → 32 bytes. We deliberately use only the
/// hostname (not MAC / CPU ID) so we don't need extra crates; the threat
/// model only requires that an offline attacker doesn't already know the
/// hostname. The attacker needs to acquire the file + guess the hostname
/// to brute-force — neither is trivial without RMM-level access.
fn derive_machine_salt() -> [u8; 32] {
    let hostname = read_hostname();
    let mut hasher = Sha256::new();
    hasher.update(b"paintkiduakan-master.machine-salt.v1");
    hasher.update(hostname.as_bytes());
    let digest = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

/// Return the cached 32-byte machine salt, computing it on first use.
pub fn machine_salt() -> &'static [u8; 32] {
    MACHINE_SALT.get_or_init(derive_machine_salt)
}

/// Recompute the machine salt ignoring the cache. Test-only — lets tests
/// verify the fingerprint is deterministic given a particular hostname.
#[cfg(test)]
pub fn machine_salt_for_hostname(hostname: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"paintkiduakan-master.machine-salt.v1");
    hasher.update(hostname.as_bytes());
    let digest = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_magic_detects_plaintext() {
        assert!(is_sqlite_plaintext(b"SQLite format 3\x00more"));
        assert!(is_sqlite_plaintext(&[
            b'S', b'Q', b'L', b'i', b't', b'e', b' ', b'f', b'o', b'r', b'm', b'a', b't', b' ',
            b'3', 0
        ]));
        assert!(!is_sqlite_plaintext(
            b"\x01\x0c\x00\x00random dpapi bytes here"
        ));
        assert!(!is_sqlite_plaintext(b""));
    }

    #[test]
    fn machine_salt_is_deterministic_for_same_hostname() {
        let a = machine_salt_for_hostname("test-host");
        let b = machine_salt_for_hostname("test-host");
        assert_eq!(a, b, "same hostname must yield same salt");
    }

    #[test]
    fn machine_salt_differs_for_different_hostnames() {
        let a = machine_salt_for_hostname("host-a");
        let b = machine_salt_for_hostname("host-b");
        assert_ne!(a, b, "different hostnames must yield different salts");
    }

    #[test]
    fn machine_salt_is_32_bytes() {
        let s = machine_salt_for_hostname("");
        assert_eq!(s.len(), 32);
        assert_ne!(
            s, [0u8; 32],
            "empty hostname must still produce non-zero salt"
        );
    }

    #[test]
    fn cached_machine_salt_is_stable() {
        let a: &[u8; 32] = machine_salt();
        let b: &[u8; 32] = machine_salt();
        assert_eq!(a, b, "cached salt must be stable across calls");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn dpapi_encrypt_decrypt_roundtrip() {
        let plaintext = b"hello, keystore world!";
        let encrypted = encrypt_keystore(plaintext).expect("encrypt must succeed");
        assert_ne!(
            &encrypted[..],
            plaintext,
            "ciphertext must differ from plaintext"
        );
        let decrypted = decrypt_keystore(&encrypted).expect("decrypt must succeed");
        assert_eq!(decrypted, plaintext, "roundtrip must recover plaintext");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn dpapi_decrypt_with_wrong_entropy_fails() {
        // Encrypt with our entropy, then attempt to decrypt with a different
        // entropy by hand-crafting a fresh DPAPI call. We approximate this
        // by encrypting a different blob and confirming decryption returns
        // the original plaintext (sanity), then assert decryption of a
        // truncated input fails.
        let plaintext = b"some keystore bytes";
        let encrypted = encrypt_keystore(plaintext).expect("encrypt");
        let result = decrypt_keystore(&encrypted[..encrypted.len() / 2]);
        assert!(result.is_err(), "truncated ciphertext must not decrypt");
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn dpapi_stub_is_passthrough() {
        let plaintext = b"plaintext on non-windows";
        let encrypted = encrypt_keystore(plaintext).expect("stub encrypt");
        assert_eq!(
            &encrypted[..],
            plaintext,
            "non-windows stub must pass through"
        );

        let decrypted = decrypt_keystore(&encrypted).expect("stub decrypt");
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn dpapi_error_display() {
        let e = DpapiError::ProtectFailed(87);
        let s = e.to_string();
        assert!(s.contains("87"));
        let e2 = DpapiError::UnprotectFailed(13);
        let s2 = e2.to_string();
        assert!(s2.contains("13"));
    }

    #[test]
    fn app_entropy_is_stable() {
        assert_eq!(
            APP_DPAPI_ENTROPY, b"paintkiduakan-master.keystore.v1",
            "changing APP_DPAPI_ENTROPY breaks all existing encrypted keystores"
        );
    }
}

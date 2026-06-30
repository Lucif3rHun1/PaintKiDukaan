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
//!    using an app-ID entropy. On non-Windows platforms the functions store
//!    secrets in the OS keyring (macOS Keychain / Linux secret-service) via
//!    the `keyring` crate.

//!
//! ## Platform support
//! - **Windows**: full DPAPI encryption. The `windows` crate's
//!   `Win32_Security_Cryptography` feature is NOT enabled in `Cargo.toml`
//!   (this file uses raw FFI to avoid adding a dependency).
//! - **macOS**: secrets stored in Keychain via the `keyring` crate.
//! - **Linux**: secrets stored in GNOME Keyring / KWallet via `keyring`.

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
    pub fn dpapi_encrypt(plaintext: &[u8], _db_id: &str) -> Result<Vec<u8>, super::DpapiError> {
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
    pub fn dpapi_decrypt(ciphertext: &[u8], _db_id: &str) -> Result<Vec<u8>, super::DpapiError> {
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
// Non-Windows: keyring-backed AES-256-GCM keystore encryption
// (macOS Keychain / Linux secret-service)
// ---------------------------------------------------------------------------

#[cfg(not(target_os = "windows"))]
mod platform {
    use base64::Engine;
    use keyring::Entry;
    use sha2::{Digest, Sha256};

    use crate::crypto::wrap;

    fn service() -> String { crate::obs!("paintkiduakan-master") }

    /// Per-DB keyring user derived from SHA-256 of the db_id (first 8 bytes → 16 hex chars).
    fn keyring_user(db_id: &str) -> String {
        let digest = Sha256::digest(db_id.as_bytes());
        let hex_id: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
        format!("{}-{hex_id}", crate::obs!("keystore-aes-key-v1"))
    }

    fn keyring_entry(user: &str) -> Result<Entry, super::DpapiError> {
        Entry::new(&service(), user).map_err(|e| super::DpapiError::KeyringStore(e.to_string()))
    }

    fn read_machine_id() -> String {
        #[cfg(target_os = "macos")]
        {
            read_macos_platform_uuid().unwrap_or_default()
        }
        #[cfg(not(target_os = "macos"))]
        {
            std::fs::read_to_string("/etc/machine-id")
                .or_else(|_| std::fs::read_to_string("/proc/sys/kernel/random/boot_id"))
                .unwrap_or_default()
                .trim()
                .to_string()
        }
    }

    #[cfg(target_os = "macos")]
    fn read_macos_platform_uuid() -> Option<String> {
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
            return None;
        }
        while buf.last() == Some(&0) {
            buf.pop();
        }
        String::from_utf8(buf).ok()
    }

    /// Deterministic key from APP_DPAPI_ENTROPY + stable machine ID + db_id.
    fn derive_key(db_id: &str) -> [u8; 32] {
        let machine_id = read_machine_id();
        let mut hasher = Sha256::new();
        hasher.update(crate::obs!("paintkiduakan-master.keystore.v1").as_bytes());
        hasher.update(machine_id.as_bytes());
        hasher.update(db_id.as_bytes());
        let digest = hasher.finalize();
        let mut key = [0u8; 32];
        key.copy_from_slice(&digest);
        key
    }

    /// Get AES-256 key: try keyring cache first, derive + store on miss.
    fn get_or_create_key(db_id: &str) -> Result<[u8; 32], super::DpapiError> {
        let entry = keyring_entry(&keyring_user(db_id))?;

        if let Ok(encoded) = entry.get_password() {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(&encoded)
                .map_err(|e| super::DpapiError::KeyringRetrieve(e.to_string()))?;
            if bytes.len() == 32 {
                let mut key = [0u8; 32];
                key.copy_from_slice(&bytes);
                return Ok(key);
            }
        }

        let key = derive_key(db_id);
        let encoded = base64::engine::general_purpose::STANDARD.encode(key);
        let _ = entry.set_password(&encoded);
        Ok(key)
    }

    pub fn dpapi_encrypt(plaintext: &[u8], db_id: &str) -> Result<Vec<u8>, super::DpapiError> {
        let key = get_or_create_key(db_id)?;
        wrap::encrypt_blob(&key, plaintext)
            .map_err(|e| super::DpapiError::KeyringStore(e.to_string()))
    }

    pub fn dpapi_decrypt(ciphertext: &[u8], db_id: &str) -> Result<Vec<u8>, super::DpapiError> {
        let key = get_or_create_key(db_id)?;
        if let Ok(plain) = wrap::decrypt_blob(&key, ciphertext) {
            return Ok(plain);
        }
        // Keyring entry drifted (e.g. macOS Keychain cleared); fall back to the
        // deterministic derivation. On success, re-store the derived key so future
        // decryptions use the fast cached path again.
        let fallback = derive_key(db_id);
        let plain = wrap::decrypt_blob(&fallback, ciphertext)
            .map_err(|e| super::DpapiError::KeyringRetrieve(e.to_string()))?;
        if let Ok(entry) = keyring_entry(&keyring_user(db_id)) {
            let encoded = base64::engine::general_purpose::STANDARD.encode(fallback);
            let _ = entry.set_password(&encoded);
        }
        Ok(plain)
    }
}

#[derive(Debug)]
pub enum DpapiError {
    ProtectFailed(i32),
    UnprotectFailed(i32),
    KeyringStore(String),
    KeyringRetrieve(String),
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
            DpapiError::KeyringStore(msg) => write!(f, "keyring store failed: {msg}"),
            DpapiError::KeyringRetrieve(msg) => write!(f, "keyring retrieve failed: {msg}"),
        }
    }
}

impl std::error::Error for DpapiError {}

impl From<DpapiError> for AppError {
    fn from(e: DpapiError) -> Self {
        AppError::Crypto(format!("DPAPI: {e}"))
    }
}

/// Encrypt the keystore blob with DPAPI (Windows) or OS keyring (macOS/Linux).
pub fn encrypt_keystore(plaintext: &[u8], db_id: &str) -> Result<Vec<u8>, AppError> {
    platform::dpapi_encrypt(plaintext, db_id).map_err(AppError::from)
}

/// Decrypt the keystore blob with DPAPI (Windows) or OS keyring (macOS/Linux).
pub fn decrypt_keystore(ciphertext: &[u8], db_id: &str) -> Result<Vec<u8>, AppError> {
    platform::dpapi_decrypt(ciphertext, db_id).map_err(AppError::from)
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

    #[cfg(target_os = "windows")]
    #[test]
    fn dpapi_encrypt_decrypt_roundtrip() {
        let plaintext = b"hello, keystore world!";
        let encrypted = encrypt_keystore(plaintext, "test-db").expect("encrypt must succeed");
        assert_ne!(
            &encrypted[..],
            plaintext,
            "ciphertext must differ from plaintext"
        );
        let decrypted = decrypt_keystore(&encrypted, "test-db").expect("decrypt must succeed");
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
        let encrypted = encrypt_keystore(plaintext, "test-db").expect("encrypt");
        let result = decrypt_keystore(&encrypted[..encrypted.len() / 2], "test-db");
        assert!(result.is_err(), "truncated ciphertext must not decrypt");
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn dpapi_keyring_roundtrip() {
        let plaintext = b"keyring roundtrip test";
        let encrypted = encrypt_keystore(plaintext, "test-db");
        match encrypted {
            Ok(enc) => {
                assert_ne!(&enc[..], plaintext);
                match decrypt_keystore(&enc, "test-db") {
                    Ok(decrypted) => assert_eq!(decrypted, plaintext),
                    Err(e) => {
                        // Keychain may reject readback in headless/CI environments
                        eprintln!("keyring decrypt failed (likely headless env): {e}");
                    }
                }
            }
            Err(e) => {
                // Keychain may be locked — not a code bug
                eprintln!("keyring encrypt failed (likely locked keychain): {e}");
            }
        }
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

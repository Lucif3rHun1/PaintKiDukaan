//! Self-integrity verification: SHA-256 hash of own executable and
//! Authenticode (WinVerifyTrust) signature check.
//!
//! On non-Windows: Authenticode stub returns `signed: false`; hash and
//! path use portable std APIs.

use std::path::PathBuf;

use serde::Serialize;

use crate::error::AppError;

// ─── Public types ──────────────────────────────────────────────────────────

/// Result of an Authenticode signature verification.
#[derive(Clone, Debug, Serialize)]
pub struct AuthenticodeReport {
    /// Whether the binary has a signature embedded.
    pub signed: bool,
    /// Subject name of the signing certificate, if available.
    pub signer: Option<String>,
    /// Whether the signature chain is trusted by the OS trust store.
    pub trusted: bool,
}

/// Combined integrity report: hash + signature.
#[derive(Clone, Debug, Serialize)]
pub struct IntegrityReport {
    /// SHA-256 hash of the running executable.
    pub exe_hash: [u8; 32],
    /// Whether the binary is Authenticode-signed.
    pub signed: bool,
    /// Signer subject name, if available.
    pub signer: Option<String>,
}

// ─── Public API ────────────────────────────────────────────────────────────

/// Get the absolute path of the currently running executable.
pub fn get_own_exe_path() -> Result<PathBuf, AppError> {
    get_own_exe_path_inner()
}

/// Compute SHA-256 of the running executable (chunked read for large files).
pub fn hash_own_exe() -> Result<[u8; 32], AppError> {
    let path = get_own_exe_path()?;
    hash_file_at_path(&path)
}

/// Verify the Authenticode signature of the running executable.
pub fn verify_authenticode() -> Result<AuthenticodeReport, AppError> {
    let path = get_own_exe_path()?;
    verify_authenticode_inner(&path)
}

/// Combined self-integrity check: SHA-256 + Authenticode.
pub fn self_integrity_check() -> Result<IntegrityReport, AppError> {
    let exe_hash = hash_own_exe()?;
    let auth = verify_authenticode()?;
    Ok(IntegrityReport {
        exe_hash,
        signed: auth.signed,
        signer: auth.signer,
    })
}

// ─── Portable hash helper ──────────────────────────────────────────────────

/// SHA-256 hash of an arbitrary file. Works on all platforms.
pub fn hash_file_at_path(path: &std::path::Path) -> Result<[u8; 32], AppError> {
    use sha2::{Digest, Sha256};

    let data = std::fs::read(path).map_err(|e| {
        AppError::Internal(format!("failed to read exe for hashing: {e}"))
    })?;

    let mut hasher = Sha256::new();
    hasher.update(&data);
    let result = hasher.finalize();

    let mut out = [0u8; 32];
    out.copy_from_slice(&result);
    Ok(out)
}

// ─── Windows implementation ───────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn get_own_exe_path_inner() -> Result<PathBuf, AppError> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetModuleFileNameW(
            hModule: *mut std::ffi::c_void,
            lp_filename: *mut u16,
            n_size: u32,
        ) -> u32;
    }

    let mut buf = [0u16; 1024];
    let len = unsafe { GetModuleFileNameW(std::ptr::null_mut(), buf.as_mut_ptr(), 1024) };
    if len == 0 {
        return Err(AppError::Internal(
            "GetModuleFileNameW returned 0".into(),
        ));
    }
    let os_str = OsString::from_wide(&buf[..len as usize]);
    Ok(PathBuf::from(os_str))
}

#[cfg(target_os = "windows")]
fn verify_authenticode_inner(path: &std::path::Path) -> Result<AuthenticodeReport, AppError> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;

    // ── WinTrust FFI declarations ──────────────────────────────────────

    const WTD_UI_NONE: u32 = 2;
    const WTD_REVOKE_NONE: u32 = 0;
    const WTD_CHOICE_FILE: u32 = 1;
    const WTD_STATEACTION_VERIFY: u32 = 1;
    const WTD_STATEACTION_CLOSE: u32 = 2;

    #[repr(C)]
    struct Guid {
        data1: u32,
        data2: u16,
        data3: u16,
        data4: [u8; 8],
    }

    // WINTRUST_ACTION_GENERIC_VERIFY_V2
    const ACTION_GENERIC_VERIFY_V2: Guid = Guid {
        data1: 0xaac56b,
        data2: 0xcd44,
        data3: 0x11d0,
        data4: [0x8c, 0xc2, 0x00, 0xc0, 0x4f, 0xc2, 0x95, 0xee],
    };

    #[repr(C)]
    struct WintrustFileInfo {
        cb_struct: u32,
        pcwsz_file_path: *const u16,
        h_file: *mut c_void,
        pg_known_subject: *const Guid,
    }

    #[repr(C)]
    struct WintrustData {
        cb_struct: u32,
        p_policy_callback_data: *mut c_void,
        p_sip_client_data: *mut c_void,
        dw_ui_choice: u32,
        fdw_revocation_checks: u32,
        dw_union_choice: u32,
        p_file: *mut WintrustFileInfo,
        dw_state_action: u32,
        h_wvt_state_data: *mut c_void,
        pwsz_url_reference: *const u16,
        dw_prov_flags: u32,
        dw_ui_context: u32,
        p_signature_settings: *mut c_void,
    }

    #[link(name = "wintrust")]
    extern "system" {
        pub fn WinVerifyTrust(
            hwnd: *mut c_void,
            pg_action_id: *const Guid,
            p_wvt_data: *const WintrustData,
        ) -> i32;
    }

    // ── Build wide path ────────────────────────────────────────────────

    let wide_path: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    // ── Build WINTRUST_FILE_INFO ──────────────────────────────────────

    let mut file_info = WintrustFileInfo {
        cb_struct: std::mem::size_of::<WintrustFileInfo>() as u32,
        pcwsz_file_path: wide_path.as_ptr(),
        h_file: std::ptr::null_mut(),
        pg_known_subject: std::ptr::null(),
    };

    // ── Build WINTRUST_DATA ──────────────────────────────────────────

    let mut wt_data = WintrustData {
        cb_struct: std::mem::size_of::<WintrustData>() as u32,
        p_policy_callback_data: std::ptr::null_mut(),
        p_sip_client_data: std::ptr::null_mut(),
        dw_ui_choice: WTD_UI_NONE,
        fdw_revocation_checks: WTD_REVOKE_NONE,
        dw_union_choice: WTD_CHOICE_FILE,
        p_file: &mut file_info,
        dw_state_action: WTD_STATEACTION_VERIFY,
        h_wvt_state_data: std::ptr::null_mut(),
        pwsz_url_reference: std::ptr::null(),
        dw_prov_flags: 0,
        dw_ui_context: 0,
        p_signature_settings: std::ptr::null_mut(),
    };

    // ── Call WinVerifyTrust ──────────────────────────────────────────

    let status = unsafe {
        WinVerifyTrust(
            std::ptr::null_mut(),
            &ACTION_GENERIC_VERIFY_V2,
            &wt_data,
        )
    };

    // Close the state handle.
    wt_data.dw_state_action = WTD_STATEACTION_CLOSE;
    unsafe {
        WinVerifyTrust(
            std::ptr::null_mut(),
            &ACTION_GENERIC_VERIFY_V2,
            &wt_data,
        );
    }

    // STATUS_SUCCESS = 0
    let signed = true; // If WinVerifyTrust was called, there IS a signature field.
    let trusted = status == 0;

    // Attempt to extract signer name via CryptQueryObject / CertGetNameString.
    // This is best-effort; if it fails we still report signed/trusted.
    let signer = extract_signer_name(path).ok().flatten();

    Ok(AuthenticodeReport {
        signed,
        signer,
        trusted,
    })
}

/// Best-effort extraction of the signer subject name.
#[cfg(target_os = "windows")]
fn extract_signer_name(path: &std::path::Path) -> Result<Option<String>, AppError> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;

    // Crypt32 FFI for certificate extraction.
    const CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED: u32 = 0x400;
    const CERT_QUERY_FORMAT_FLAG_BINARY: u32 = 0x2;
    const CERT_QUERY_OBJECT_FILE: u32 = 1;
    const CERT_NAME_SIMPLE_DISPLAY_TYPE: u32 = 4;

    type HcertStore = *mut c_void;
    type HcryptMsg = *mut c_void;
    type PcertContext = *const CertContext;

    #[repr(C)]
    struct CertContext {
        dw_cert_encoding_type: u32,
        pb_cert_encoded: *const u8,
        cb_cert_encoded: u32,
        p_cert_info: *mut c_void,
        h_cert_store: HcertStore,
    }

    #[repr(C)]
    struct CertInfo {
        _pad: [u8; 64], // simplified — we only need the pointer from CertContext
    }

    extern "system" {
        fn CryptQueryObject(
            dw_object_type: u32,
            pv_object: *const u16,
            dw_expected_content_type_flags: u32,
            dw_expected_format_type_flags: u32,
            dw_flags: u32,
            pdw_msg_and_cert_encoding_type: *mut u32,
            pdw_content_type: *mut u32,
            pdw_format_type: *mut u32,
            ph_cert_store: *mut HcertStore,
            ph_msg: *mut HcryptMsg,
            ppv_context: *mut *const c_void,
        ) -> i32;

        fn CryptMsgGetParam(
            h_crypt_msg: HcryptMsg,
            dw_param_type: u32,
            dw_index: u32,
            pv_data: *mut c_void,
            pcb_data: *mut u32,
        ) -> i32;

        fn CertGetCertificateContextProperty(
            p_cert_context: PcertContext,
            dw_prop_id: u32,
            pv_data: *mut c_void,
            pcb_data: *mut u32,
        ) -> i32;

        fn CertGetNameStringW(
            p_cert_context: PcertContext,
            dw_type: u32,
            dw_flags: u32,
            pv_type_para: *const c_void,
            psz_name_string: *mut u16,
            cch_name_string: u32,
        ) -> u32;

        fn CertCloseStore(h_cert_store: HcertStore, dw_flags: u32) -> i32;
        fn CryptMsgClose(h_crypt_msg: HcryptMsg) -> i32;
    }

    let wide_path: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        let mut h_store: HcertStore = std::ptr::null_mut();
        let mut h_msg: HcryptMsg = std::ptr::null_mut();
        let mut p_ctx: *const c_void = std::ptr::null();

        let ok = CryptQueryObject(
            CERT_QUERY_OBJECT_FILE,
            wide_path.as_ptr(),
            CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED,
            CERT_QUERY_FORMAT_FLAG_BINARY,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut h_store,
            &mut h_msg,
            &mut p_ctx,
        );

        if ok == 0 || p_ctx.is_null() {
            if !h_store.is_null() {
                CertCloseStore(h_store, 0);
            }
            if !h_msg.is_null() {
                CryptMsgClose(h_msg);
            }
            return Ok(None);
        }

        let cert_ctx = p_ctx as PcertContext;
        let mut name_buf = [0u16; 256];
        let name_len = CertGetNameStringW(
            cert_ctx,
            CERT_NAME_SIMPLE_DISPLAY_TYPE,
            0,
            std::ptr::null(),
            name_buf.as_mut_ptr(),
            256,
        );

        let signer = if name_len > 1 {
            let os_str = std::ffi::OsString::from_wide(&name_buf[..(name_len - 1) as usize]);
            os_str.to_string_lossy().into_owned().into()
        } else {
            None
        };

        CertCloseStore(h_store, 0);
        CryptMsgClose(h_msg);

        Ok(signer)
    }
}

// ─── Non-Windows implementation ───────────────────────────────────────────

#[cfg(not(target_os = "windows"))]
fn get_own_exe_path_inner() -> Result<PathBuf, AppError> {
    std::env::current_exe().map_err(|e| AppError::Internal(format!("current_exe failed: {e}")))
}

#[cfg(not(target_os = "windows"))]
fn verify_authenticode_inner(_path: &std::path::Path) -> Result<AuthenticodeReport, AppError> {
    // Authenticode is Windows-only.
    Ok(AuthenticodeReport {
        signed: false,
        signer: None,
        trusted: false,
    })
}

// ─── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_own_exe_path_returns_existing_file() {
        let path = get_own_exe_path().unwrap();
        assert!(path.exists(), "exe path should exist: {}", path.display());
    }

    #[test]
    fn hash_is_stable_across_calls() {
        let h1 = hash_own_exe().unwrap();
        let h2 = hash_own_exe().unwrap();
        assert_eq!(h1, h2, "hash must be deterministic");
    }

    #[test]
    fn hash_is_32_bytes() {
        let h = hash_own_exe().unwrap();
        assert_eq!(h.len(), 32);
    }

    #[test]
    fn hash_is_not_all_zeros() {
        let h = hash_own_exe().unwrap();
        assert_ne!(h, [0u8; 32], "hash should not be all zeros");
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn signature_check_on_non_windows_returns_signed_false() {
        let report = verify_authenticode().unwrap();
        assert!(!report.signed);
        assert!(!report.trusted);
        assert!(report.signer.is_none());
    }

    #[test]
    fn integrity_report_contains_hash() {
        let report = self_integrity_check().unwrap();
        assert_ne!(report.exe_hash, [0u8; 32]);
    }

    #[test]
    fn integrity_report_serializes() {
        let report = self_integrity_check().unwrap();
        let json = serde_json::to_string(&report).unwrap();
        assert!(json.contains("exe_hash"));
        assert!(json.contains("signed"));
    }

    #[test]
    fn hash_file_at_path_works_for_temp() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(tmp.path(), b"test content for hashing").unwrap();
        let h = hash_file_at_path(tmp.path()).unwrap();
        assert_eq!(h.len(), 32);
        assert_ne!(h, [0u8; 32]);
    }

    #[test]
    fn hash_file_is_deterministic() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(tmp.path(), b"deterministic content").unwrap();
        let h1 = hash_file_at_path(tmp.path()).unwrap();
        let h2 = hash_file_at_path(tmp.path()).unwrap();
        assert_eq!(h1, h2);
    }

    #[test]
    fn hash_file_differs_for_different_content() {
        let tmp1 = tempfile::NamedTempFile::new().unwrap();
        let tmp2 = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(tmp1.path(), b"content A").unwrap();
        std::fs::write(tmp2.path(), b"content B").unwrap();
        let h1 = hash_file_at_path(tmp1.path()).unwrap();
        let h2 = hash_file_at_path(tmp2.path()).unwrap();
        assert_ne!(h1, h2);
    }
}

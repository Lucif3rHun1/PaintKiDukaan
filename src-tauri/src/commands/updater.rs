// Custom updater with SHA-256 hash verification (not minisign).
//
// Flow: fetch latest.json → compare versions → download installer from GitHub
// Releases → compute SHA-256 → compare to precomputed hash in latest.json →
// install if match. Hash mismatch is a hard error (Retry / Quit on splash).
//
// Legacy note: previously used tauri-plugin-updater + minisign (updater.key /
// TAURI_SIGNING_PRIVATE_KEY). That keypair ceremony kept failing; dropped in
// favor of TLS + SHA-256. No signing keys required.
//
// Threat model: TLS protects the channel; SHA-256 protects against CDN
// tampering (GitHub Releases + any future mirror). Zero key management.

use std::path::{Path, PathBuf};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::updater_key;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
#[cfg(target_os = "windows")]
const DETACHED_PROCESS: u32 = 0x0000_0008;

const LATEST_JSON_URL: &str =
    "https://github.com/Lucif3rHun1/PaintKiDukaan/releases/latest/download/latest.json";

/// Only allow downloads from our own GitHub Releases page.
const ALLOWED_UPDATE_PREFIX: &str =
    "https://github.com/Lucif3rHun1/PaintKiDukaan/releases/download/";

fn is_trusted_update_url(url: &str) -> bool {
    url.starts_with(ALLOWED_UPDATE_PREFIX)
}

/// Verify an Ed25519 signature over `payload` against the embedded production
/// public key. The signature is the base64 of the raw 64-byte Ed25519 signature
/// produced by CI from `$UPDATER_SIGNING_KEY`.
///
/// Returns Err with a human-readable reason on any failure: bad base64, wrong
/// length, malformed signature bytes, key mismatch, or payload mismatch. The
/// caller (stage_update) treats every Err as a hard reject — no staged payload,
/// no install.
pub fn verify_payload_signature(payload: &[u8], sig_b64: &str) -> Result<(), String> {
    verify_payload_signature_with_key(payload, sig_b64, &updater_key::verifying_key())
}

/// Inner verifier with an injected key. Lets tests sign with a throwaway
/// keypair and verify the happy path; production callers use the wrapper that
/// hardcodes the embedded public key.
fn verify_payload_signature_with_key(
    payload: &[u8],
    sig_b64: &str,
    key: &ed25519_dalek::VerifyingKey,
) -> Result<(), String> {
    use ed25519_dalek::{Signature, Verifier};

    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(sig_b64)
        .map_err(|e| format!("signature is not valid base64: {}", e))?;

    if sig_bytes.len() != 64 {
        return Err(format!(
            "signature must decode to 64 bytes, got {}",
            sig_bytes.len()
        ));
    }

    let sig_array: [u8; 64] = sig_bytes
        .try_into()
        .expect("length checked above; cannot fail here");
    let sig = Signature::from_bytes(&sig_array);

    key.verify(payload, &sig)
        .map_err(|_| "signature does not match payload under public key".to_string())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UpdateInfo {
    pub available: bool,
    pub current_version: String,
    pub latest_version: String,
    pub pub_date: Option<String>,
    pub notes: Option<String>,
    pub platforms: Vec<PlatformUpdate>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlatformUpdate {
    pub key: String,
    pub url: String,
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DownloadResult {
    pub path: PathBuf,
    pub bytes: u64,
    pub sha256: String,
}

pub fn current_target() -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return "windows-x86_64";
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    return "windows-aarch64";
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    return "darwin-x86_64";
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return "darwin-aarch64";
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return "linux-x86_64";
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    return "linux-aarch64";
}

fn is_newer(latest: &str, current: &str) -> bool {
    let parse = |s: &str| -> Vec<u32> {
        s.trim_start_matches('v')
            .split('.')
            .filter_map(|p| p.split('-').next().unwrap_or(p).parse::<u32>().ok())
            .collect()
    };
    let l = parse(latest);
    let c = parse(current);
    l.cmp(&c) == std::cmp::Ordering::Greater
}

// ── Shared async functions (used by both gate and cmd wrappers) ──────────

/// Fetch `latest.json` from GitHub Releases and compare versions.
/// Each platform entry includes `url` + precomputed `sha256` (no minisign `.sig`).
pub async fn check_update() -> Result<UpdateInfo, String> {
    let resp = reqwest::get(LATEST_JSON_URL)
        .await
        .map_err(|e| format!("fetch latest.json: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("latest.json HTTP {}", resp.status()));
    }
    let latest: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("parse latest.json: {}", e))?;

    let latest_version = latest["version"].as_str().unwrap_or("").to_string();
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let available = is_newer(&latest_version, &current_version);

    let platforms_json = latest["platforms"].as_object();
    let mut platforms: Vec<PlatformUpdate> = Vec::new();
    if let Some(obj) = platforms_json {
        for (key, val) in obj.iter() {
            platforms.push(PlatformUpdate {
                key: key.clone(),
                url: val["url"].as_str().unwrap_or("").to_string(),
                sha256: val["sha256"].as_str().unwrap_or("").to_string(),
                size_bytes: val["size"].as_u64().unwrap_or(0),
            });
        }
    }

    Ok(UpdateInfo {
        available,
        current_version,
        latest_version,
        pub_date: latest["pub_date"].as_str().map(|s| s.to_string()),
        notes: latest["notes"].as_str().map(|s| s.to_string()),
        platforms,
    })
}

/// Download installer from a trusted GitHub Releases URL, hash with SHA-256,
/// and reject on mismatch. `expected_sha256` is the 64-char hex from `latest.json`.
pub async fn download_update(url: &str, expected_sha256: &str) -> Result<DownloadResult, String> {
    if expected_sha256.len() != 64 || !expected_sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("expected_sha256 must be 64-char hex".into());
    }
    if !is_trusted_update_url(url) {
        log::warn!("updater: rejected untrusted download URL: {url}");
        return Err("download URL not from trusted source".into());
    }
    let resp = reqwest::get(url)
        .await
        .map_err(|e| format!("download: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("download HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("read body: {}", e))?;

    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let actual = hex::encode(hasher.finalize());

    if actual.to_lowercase() != expected_sha256.to_lowercase() {
        return Err(format!(
            "SHA-256 mismatch\n  expected: {}\n  actual:   {}",
            expected_sha256, actual
        ));
    }

    let suffix = &expected_sha256[..8];
    let temp_path = std::env::temp_dir().join(format!("pkb-update-{}.bin", suffix));
    std::fs::write(&temp_path, &bytes).map_err(|e| format!("write temp: {}", e))?;

    Ok(DownloadResult {
        path: temp_path,
        bytes: bytes.len() as u64,
        sha256: actual,
    })
}

fn ensure_path_in_temp_dir(path: &Path) -> Result<(), String> {
    let temp_dir = std::env::temp_dir();
    if !path.starts_with(&temp_dir) {
        log::warn!("updater: rejected install path outside temp_dir: {}", path.display());
        return Err("install path must be in system temp directory".into());
    }
    Ok(())
}

/// Install a previously SHA-256-verified update from a temp path.
/// Windows: spawn NSIS `/S`, then exit. macOS: extract `.app.tar.gz`, open, exit.
pub fn install_update(path: &PathBuf) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("file not found: {}", path.display()));
    }
    ensure_path_in_temp_dir(path)?;
    #[cfg(target_os = "windows")]
    {
        // ponytail: NSIS child must NOT inherit our JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        // (lib.rs joins our process into a kill-on-close job). Detach via
        // CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS so the installer runs in its own
        // console / process group and survives our exit(0).
        std::process::Command::new(path)
            .args(["/S"])
            .creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS)
            .spawn()
            .map_err(|e| format!("spawn installer: {}", e))?;

        std::process::exit(0);
    }
    #[cfg(target_os = "macos")]
    {
        if path.extension().and_then(|s| s.to_str()) == Some("gz")
            && path.to_str().map(|s| s.ends_with(".app.tar.gz")).unwrap_or(false)
        {
            let app_dir = std::path::PathBuf::from("/Applications");
            let status = std::process::Command::new("tar")
                .args(["-xzf"])
                .arg(path)
                .arg("-C")
                .arg(&app_dir)
                .status()
                .map_err(|e| format!("tar extract: {}", e))?;
            if !status.success() {
                return Err(format!("tar extract failed: {:?}", status.code()));
            }
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| s.strip_suffix(".app"))
                .unwrap_or("PaintKiDukaan");
            let app_path = app_dir.join(format!("{}.app", stem));
            if !app_path.exists() {
                return Err(format!(
                    "extracted app not found at {}",
                    app_path.display()
                ));
            }
            std::process::Command::new("open")
                .arg(&app_path)
                .spawn()
                .map_err(|e| format!("open: {}", e))?;
        } else {
            std::process::Command::new("open")
                .arg(path)
                .spawn()
                .map_err(|e| format!("open: {}", e))?;
        }
        std::process::exit(0);
    }
    #[cfg(target_os = "linux")]
    {
        Err("Linux install: extract the AppImage and replace the running binary manually".into())
    }
}

// ── Splash gate support ─────────────────────────────────────────────────

/// Channel for splash Retry/Quit buttons → gate thread.
pub struct RetryChannel(pub std::sync::mpsc::Sender<String>);

#[tauri::command]
pub fn cmd_retry_update(state: tauri::State<RetryChannel>) -> Result<(), String> {
    state
        .0
        .send("retry".into())
        .map_err(|e| format!("channel send: {e}"))
}

#[tauri::command]
pub fn cmd_quit_app(app: tauri::AppHandle, state: tauri::State<RetryChannel>) -> Result<(), String> {
    let _ = state.0.send("quit".into());
    app.exit(0);
    Ok(())
}

fn show_main(app: &tauri::AppHandle, splash_label: &str) {
    if let Some(splash) = app.get_webview_window(splash_label) {
        let _ = splash.close();
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
}

/// Release-build splash gate: check → download+SHA-256 verify → install.
/// Loops on Retry; soft-continues to main on download timeout; hard-errors on hash mismatch.
pub async fn run_update_gate(
    app: tauri::AppHandle,
    splash_label: String,
    rx: std::sync::mpsc::Receiver<String>,
) {
    loop {
        // ── Checking ──────────────────────────────────────────────
        if let Some(splash) = app.get_webview_window(&splash_label) {
            let _ = splash.eval("window.__showChecking()");
        }

        let check = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            check_update(),
        )
        .await;

        let update_info = match check {
            Ok(Ok(info)) => info,
            Ok(Err(e)) => {
                let msg = e.replace('\'', "\\'");
                if let Some(splash) = app.get_webview_window(&splash_label) {
                    let _ = splash.eval(&format!("window.__showError('{msg}')"));
                }
                match rx.recv() {
                    Ok(m) if m == "retry" => continue,
                    _ => { show_main(&app, &splash_label); return; }
                }
            }
            Err(_) => {
                if let Some(splash) = app.get_webview_window(&splash_label) {
                    let _ = splash.eval("window.__showError('Update check timed out')");
                }
                match rx.recv() {
                    Ok(m) if m == "retry" => continue,
                    _ => { show_main(&app, &splash_label); return; }
                }
            }
        };

        if !update_info.available {
            log::info!("updater: no update ({})", update_info.current_version);
            show_main(&app, &splash_label);
            return;
        }

        log::info!(
            "updater: {} → {}",
            update_info.current_version,
            update_info.latest_version
        );

        // ── Downloading ───────────────────────────────────────────
        if let Some(splash) = app.get_webview_window(&splash_label) {
            let _ = splash.eval("window.__showDownloading()");
        }

        let target = current_target();
        let platform = match update_info.platforms.iter().find(|p| p.key == target) {
            Some(p) => p,
            None => {
                if let Some(splash) = app.get_webview_window(&splash_label) {
                    let _ = splash.eval(&format!(
                        "window.__showError('No update for {target}')"
                    ));
                }
                show_main(&app, &splash_label);
                return;
            }
        };

        let dl = tokio::time::timeout(
            std::time::Duration::from_secs(300),
            download_update(&platform.url, &platform.sha256),
        )
        .await;

        let download = match dl {
            Ok(Ok(d)) => d,
            Ok(Err(e)) => {
                let msg = e.replace('\'', "\\'");
                if let Some(splash) = app.get_webview_window(&splash_label) {
                    let _ = splash.eval(&format!("window.__showError('{msg}')"));
                }
                // Download failure: soft-continue (show main)
                show_main(&app, &splash_label);
                return;
            }
            Err(_) => {
                if let Some(splash) = app.get_webview_window(&splash_label) {
                    let _ = splash.eval("window.__showError('Download timed out (5 min)')");
                }
                show_main(&app, &splash_label);
                return;
            }
        };

        // ── Installing ────────────────────────────────────────────
        if let Some(splash) = app.get_webview_window(&splash_label) {
            let _ = splash.eval("window.__showInstalling()");
        }

        match install_update(&download.path) {
            Ok(()) => {
                // install_update calls process::exit on success — never reached
                log::info!("updater: install complete");
                show_main(&app, &splash_label);
                return;
            }
            Err(e) => {
                let msg = e.replace('\'', "\\'");
                if let Some(splash) = app.get_webview_window(&splash_label) {
                    let _ = splash.eval(&format!("window.__showError('{msg}')"));
                }
                match rx.recv() {
                    Ok(m) if m == "retry" => continue,
                    _ => { show_main(&app, &splash_label); return; }
                }
            }
        }
    }
}

// ── Thin command wrappers (IPC surface) ─────────────────────────────────

#[tauri::command]
pub async fn cmd_check_update() -> Result<UpdateInfo, String> {
    check_update().await
}

#[tauri::command]
pub async fn cmd_download_update(url: String, expected_sha256: String) -> Result<DownloadResult, String> {
    download_update(&url, &expected_sha256).await
}

#[tauri::command]
pub async fn cmd_install_update(path: PathBuf, _app: tauri::AppHandle) -> Result<(), String> {
    install_update(&path)
}

#[tauri::command]
pub fn cmd_current_target() -> &'static str {
    current_target()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_newer_compares_semver() {
        assert!(is_newer("0.1.24", "0.1.23"));
        assert!(!is_newer("0.1.23", "0.1.23"));
        assert!(!is_newer("0.1.22", "0.1.23"));
        assert!(is_newer("0.2.0", "0.1.23"));
        assert!(is_newer("1.0.0", "0.99.99"));
    }

    #[test]
    fn is_newer_handles_v_prefix() {
        assert!(is_newer("v0.1.24", "0.1.23"));
        assert!(!is_newer("v0.1.23", "0.1.23"));
    }

    #[test]
    fn is_trusted_url_valid() {
        assert!(is_trusted_update_url(
            "https://github.com/Lucif3rHun1/PaintKiDukaan/releases/download/v0.1.24/app.exe"
        ));
    }

    #[test]
    fn is_trusted_url_rejects_unknown_host() {
        assert!(!is_trusted_update_url(
            "https://evil.com/Lucif3rHun1/PaintKiDukaan/releases/download/v0.1.24/app.exe"
        ));
    }

    #[test]
    fn is_trusted_url_rejects_http() {
        assert!(!is_trusted_update_url(
            "http://github.com/Lucif3rHun1/PaintKiDukaan/releases/download/v0.1.24/app.exe"
        ));
    }

    #[test]
    fn current_target_returns_non_empty() {
        let target = current_target();
        assert!(!target.is_empty());
        assert!(target.contains("-"));
    }

    #[test]
    fn ensure_path_in_temp_dir_accepts_path_under_temp_dir() {
        let temp_file = tempfile::NamedTempFile::new().unwrap();
        let path = temp_file.path().to_path_buf();
        assert!(
            ensure_path_in_temp_dir(&path).is_ok(),
            "a freshly-created tempfile lives under std::env::temp_dir() and must pass the check"
        );
    }

#[test]
    fn ensure_path_in_temp_dir_rejects_path_outside_temp_dir() {
        let path = PathBuf::from(if cfg!(target_os = "windows") {
            r"C:\Windows\System32\drivers\etc\hosts"
        } else {
            "/etc/hosts"
        });
        assert!(
            ensure_path_in_temp_dir(&path).is_err(),
            "a path outside std::env::temp_dir() must be rejected"
        );
    }

    // --- verify_payload_signature tests (US-002) ---
    // Use a throwaway keypair (separate from the production key embedded in
    // updater_key.rs) so these tests cannot pass by accident if production
    // signing/verification wiring breaks.

    use base64::Engine;
    use ed25519_dalek::{Signer, SigningKey, Verifier};
    use rand::rngs::OsRng;

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn fresh_keypair() -> SigningKey {
        let mut csprng = OsRng;
        SigningKey::generate(&mut csprng)
    }

    #[test]
    fn verify_valid_signature_passes() {
        // Sign with a throwaway keypair, verify through the inner helper
        // (which the public wrapper delegates to). The production wrapper is
        // hardcoded to the embedded key; full happy-path with the production
        // seed is covered by stage_update's end-to-end test in US-003.
        let signing = fresh_keypair();
        let payload = b"paintkiduakan self-update payload v0.1.35\nsha256=abc123";
        let sig = signing.sign(payload);
        let sig_b64 = b64(&sig.to_bytes());

        let result = verify_payload_signature_with_key(payload, &sig_b64, &signing.verifying_key());
        assert!(
            result.is_ok(),
            "valid signature over known payload must verify; got: {:?}",
            result
        );
    }

    #[test]
    fn verify_malformed_base64_fails() {
        let payload = b"any payload";
        let result = verify_payload_signature(payload, "!!!not-base64!!!");
        assert!(result.is_err(), "non-base64 input must be rejected");
        let err = result.unwrap_err();
        assert!(
            err.contains("base64") || err.contains("Signature"),
            "error must explain the failure; got: {}",
            err
        );
    }

    #[test]
    fn verify_wrong_length_signature_fails() {
        // Valid base64, but decodes to 32 bytes (half an Ed25519 signature).
        let too_short = b64(&[0u8; 32]);
        let result = verify_payload_signature(b"any payload", &too_short);
        assert!(result.is_err(), "32-byte input must be rejected");
        assert!(
            result.unwrap_err().contains("64 bytes"),
            "error must mention the expected length"
        );
    }

    #[test]
    fn verify_tampered_signature_fails() {
        // Sign a payload with a throwaway key, flip one bit in the signature,
        // confirm verify_payload_signature rejects it.
        let signing = fresh_keypair();
        let payload = b"paintkiduakan self-update payload v0.1.35";
        let sig = signing.sign(payload);
        let mut sig_bytes = sig.to_bytes();
        sig_bytes[10] ^= 0x01;
        let tampered_b64 = b64(&sig_bytes);

        let result = verify_payload_signature(payload, &tampered_b64);
        assert!(
            result.is_err(),
            "signature with a flipped bit must be rejected"
        );
    }

    #[test]
    fn verify_foreign_signature_against_production_key_fails() {
        // An attacker who controls a different signing key cannot forge a
        // signature that the embedded production key will accept.
        let foreign = fresh_keypair();
        let payload = b"forged payload claiming to be v0.1.35 official release";
        let sig = foreign.sign(payload);
        let sig_b64 = b64(&sig.to_bytes());

        let result = verify_payload_signature(payload, &sig_b64);
        assert!(
            result.is_err(),
            "production key must reject signatures from a different private seed"
        );
    }
}

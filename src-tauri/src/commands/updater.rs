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
use ed25519_dalek::VerifyingKey;
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
    key: &VerifyingKey,
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

/// Pending-update marker written by stage_update and consumed by
/// apply_pending_update on next launch. `signature_verified` is a defensive
/// double-check — apply_pending_update refuses to install unless this field
/// is true in the on-disk JSON, even if the staging files look intact.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PendingUpdate {
    pub version: String,
    pub staging_path: PathBuf,
    pub sha256: String,
    pub signature_verified: bool,
    pub staged_at_unix: i64,
}

/// Download `bundle_url` from a trusted GitHub Releases URL, verify SHA-256
/// against `expected_sha256_hex`, verify Ed25519 signature against the embedded
/// production public key, and stage the validated payload under
/// `staging_root/<version>/app.zip`. Writes a `pending_update.json` marker that
/// apply_pending_update reads on next launch.
///
/// Hard-rejects on any check failure; no staged payload, no marker, no install.
/// The temp `.tmp` file is removed on every failure path to keep the staging
/// dir clean for retries.
pub async fn stage_update(
    target_version: &str,
    bundle_url: &str,
    expected_sha256_hex: &str,
    sig_b64: &str,
    staging_root: &Path,
) -> Result<PathBuf, String> {
    if !is_trusted_update_url(bundle_url) {
        return Err("download URL not from trusted source".into());
    }
    if expected_sha256_hex.len() != 64 || !expected_sha256_hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("expected_sha256 must be 64-char hex".into());
    }
    let resp = reqwest::get(bundle_url)
        .await
        .map_err(|e| format!("download: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("download HTTP {}", resp.status()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("read body: {}", e))?;

    stage_update_with_key(
        target_version,
        &bytes,
        expected_sha256_hex,
        sig_b64,
        staging_root,
        &updater_key::verifying_key(),
    )
    .await
}

/// Inner stage_update that takes pre-fetched bytes + an injected VerifyingKey,
/// so unit tests can sign with a throwaway keypair and assert the SHA-256 /
/// Ed25519 / staging-dir / marker behaviour end-to-end without standing up an
/// HTTP server.
pub(crate) async fn stage_update_with_key(
    target_version: &str,
    payload: &[u8],
    expected_sha256_hex: &str,
    sig_b64: &str,
    staging_root: &Path,
    key: &VerifyingKey,
) -> Result<PathBuf, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let version_dir = staging_root.join(target_version);
    std::fs::create_dir_all(&version_dir)
        .map_err(|e| format!("create staging dir: {}", e))?;

    let tmp_path = version_dir.join("app.zip.tmp");
    std::fs::write(&tmp_path, payload).map_err(|e| format!("write tmp: {}", e))?;

    // SHA-256 check
    let mut hasher = Sha256::new();
    hasher.update(payload);
    let actual_sha256 = hex::encode(hasher.finalize());
    if actual_sha256.to_lowercase() != expected_sha256_hex.to_lowercase() {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!(
            "SHA-256 mismatch\n  expected: {}\n  actual:   {}",
            expected_sha256_hex, actual_sha256
        ));
    }

    // Ed25519 check — uses the inner helper so tests can inject a key.
    if let Err(e) = verify_payload_signature_with_key(payload, sig_b64, key) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("signature verification failed: {}", e));
    }

    let final_path = version_dir.join("app.zip");
    std::fs::rename(&tmp_path, &final_path).map_err(|e| format!("rename tmp → final: {}", e))?;

    let staged_at_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let marker = PendingUpdate {
        version: target_version.to_string(),
        staging_path: final_path.clone(),
        sha256: actual_sha256,
        signature_verified: true,
        staged_at_unix,
    };

    let marker_path = staging_root.join("pending_update.json");
    let json = serde_json::to_string_pretty(&marker)
        .map_err(|e| format!("serialize marker: {}", e))?;
    std::fs::write(&marker_path, json).map_err(|e| format!("write marker: {}", e))?;

    Ok(final_path)
}

/// Outcome of apply_pending_update. The caller (lib.rs startup wiring)
/// interprets `Applied` as "exit the old process — the new version has been
/// spawned"; `NoPending` as "continue normal startup"; `Failed` as "log + show
/// splash error + retry".
#[derive(Debug, PartialEq, Eq)]
pub enum ApplyOutcome {
    Applied,
    NoPending,
    Failed(String),
}

/// Apply a pending self-update staged by `stage_update`.
/// 1. Crash recovery: if `<exe>.bak` exists AND `<exe>` is missing, restore.
///    (If both exist we don't touch — likely a leftover from a successful
///    install; the next successful install will overwrite both.)
/// 2. Read `pending_update.json` from `staging_root`.
/// 3. Validate: `signature_verified == true`, staging zip still present.
/// 4. Rename `<exe>` → `<exe>.bak`.
/// 5. Extract the staged zip into `install_dir`.
/// 6. On extract failure: restore .bak → `<exe>`, return Failed.
/// 7. On success: delete .bak (if not held by running process), delete marker,
///    delete staging dir, spawn new `<exe>` detached, return Applied.
pub fn apply_pending_update(
    install_dir: &Path,
    current_exe_name: &str,
    staging_root: &Path,
) -> ApplyOutcome {
    let exe_path = install_dir.join(current_exe_name);
    let bak_path = install_dir.join(format!("{}.bak", current_exe_name));

    if bak_path.exists() && !exe_path.exists() {
        match std::fs::rename(&bak_path, &exe_path) {
            Ok(_) => log::info!(
                "updater: crash-recovery restored {} from .bak",
                exe_path.display()
            ),
            Err(e) => {
                return ApplyOutcome::Failed(format!(
                    "crash recovery: rename .bak → {}: {}",
                    exe_path.display(),
                    e
                ));
            }
        }
    }

    let marker_path = staging_root.join("pending_update.json");
    if !marker_path.exists() {
        return ApplyOutcome::NoPending;
    }

    let marker_text = match std::fs::read_to_string(&marker_path) {
        Ok(t) => t,
        Err(e) => {
            let _ = std::fs::remove_file(&marker_path);
            return ApplyOutcome::Failed(format!("read marker: {}", e));
        }
    };
    let marker: PendingUpdate = match serde_json::from_str(&marker_text) {
        Ok(m) => m,
        Err(e) => {
            let _ = std::fs::remove_file(&marker_path);
            log::warn!(
                "updater: corrupt pending_update.json removed: {}",
                e
            );
            return ApplyOutcome::NoPending;
        }
    };

    if !marker.signature_verified {
        let _ = std::fs::remove_file(&marker_path);
        return ApplyOutcome::NoPending;
    }
    if !marker.staging_path.exists() {
        let _ = std::fs::remove_file(&marker_path);
        log::warn!(
            "updater: marker references missing staging payload at {}",
            marker.staging_path.display()
        );
        return ApplyOutcome::NoPending;
    }

    if exe_path.exists() {
        if let Err(e) = std::fs::rename(&exe_path, &bak_path) {
            return ApplyOutcome::Failed(format!(
                "rename {} → .bak: {}",
                exe_path.display(),
                e
            ));
        }
    }

    if let Err(e) = extract_zip(&marker.staging_path, install_dir) {
        if bak_path.exists() {
            let _ = std::fs::rename(&bak_path, &exe_path);
        }
        return ApplyOutcome::Failed(format!("extract staged payload: {}", e));
    }

    let _ = std::fs::remove_file(&bak_path);
    let _ = std::fs::remove_file(&marker_path);
    if let Some(parent) = marker.staging_path.parent() {
        let _ = std::fs::remove_dir_all(parent);
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        let _ = std::process::Command::new(&exe_path)
            .creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS)
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new(&exe_path).spawn();
    }

    ApplyOutcome::Applied
}

fn extract_zip(zip_path: &Path, dest_dir: &Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| format!("open zip: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("read zip: {}", e))?;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("zip entry {}: {}", i, e))?;
        let outpath = match entry.enclosed_name() {
            Some(p) => dest_dir.join(p),
            None => continue,
        };
        if entry.is_dir() {
            std::fs::create_dir_all(&outpath).map_err(|e| format!("mkdir: {}", e))?;
            continue;
        }
        if let Some(parent) = outpath.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir parent: {}", e))?;
        }
        let mut out = std::fs::File::create(&outpath).map_err(|e| format!("create file: {}", e))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("write file: {}", e))?;
    }
    Ok(())
}

/// Default staging root: `<data_local_dir>/in.paintkiduakan.master/staging/`.
/// Matches the project's existing app-data-dir convention used by lib.rs.
pub fn default_staging_root() -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| d.join(crate::obs!("in.paintkiduakan.master")).join("staging"))
}

/// Run apply_pending_update against the running process's install dir and the
/// default staging root. Convenience for lib.rs startup wiring — avoids
/// re-implementing `current_exe().parent()` + `default_staging_root()` at every
/// call site.
pub fn apply_pending_update_for_running_process() -> ApplyOutcome {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => return ApplyOutcome::Failed(format!("current_exe: {}", e)),
    };
    let install_dir = match exe.parent() {
        Some(p) => p.to_path_buf(),
        None => return ApplyOutcome::Failed("current_exe has no parent".into()),
    };
    let current_exe_name = match exe.file_name() {
        Some(n) => n.to_string_lossy().into_owned(),
        None => return ApplyOutcome::Failed("current_exe has no file_name".into()),
    };
    let staging_root = match default_staging_root() {
        Some(p) => p,
        None => return ApplyOutcome::Failed("could not resolve data_local_dir".into()),
    };
    apply_pending_update(&install_dir, &current_exe_name, &staging_root)
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
    /// First-install NSIS installer URL + SHA-256 (legacy path; used by users
    /// who haven't installed yet). Existing field — backward-compatible.
    pub url: String,
    pub sha256: String,
    pub size_bytes: u64,
    /// Self-update signed-bundle URL (signed zip produced by CI). Optional so
    /// legacy releases without a published bundle still parse cleanly.
    #[serde(default)]
    pub bundle_url: Option<String>,
    /// Ed25519 signature over the bundle zip, base64. Required when
    /// bundle_url is set; stage_update rejects bundles without it.
    #[serde(default)]
    pub ed25519_sig: Option<String>,
    /// SHA-256 of the bundle zip. Required when bundle_url is set.
    #[serde(default)]
    pub bundle_sha256: Option<String>,
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
                bundle_url: val["bundle_url"].as_str().map(|s| s.to_string()),
                ed25519_sig: val["ed25519_sig"].as_str().map(|s| s.to_string()),
                bundle_sha256: val["bundle_sha256"].as_str().map(|s| s.to_string()),
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

/// User-initiated "Restart to apply" command. Calls apply_pending_update and,
/// if a staged update was successfully applied, exits the old process so the
/// newly-spawned detached process takes over. Returns the outcome as a string
/// for the frontend to display.
#[tauri::command]
pub fn cmd_quit_after_update(app: tauri::AppHandle) -> Result<String, String> {
    match apply_pending_update_for_running_process() {
        ApplyOutcome::Applied => {
            log::info!("updater: cmd_quit_after_update applied; exiting");
            // Brief sleep lets the IPC reply reach the frontend before exit.
            std::thread::sleep(std::time::Duration::from_millis(100));
            app.exit(0);
            Ok("applied".into())
        }
        ApplyOutcome::NoPending => Ok("no_pending".into()),
        ApplyOutcome::Failed(reason) => Err(reason),
    }
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

        // ── Self-update path: stage signed bundle ────────────────────
        // If the platform entry has a signed bundle_url + ed25519_sig +
        // bundle_sha256, use the new self-update flow (download + Ed25519
        // verify + stage). Otherwise fall back to the legacy NSIS install.
        if let (Some(bundle_url), Some(bundle_sig), Some(bundle_sha)) = (
            platform.bundle_url.as_deref(),
            platform.ed25519_sig.as_deref(),
            platform.bundle_sha256.as_deref(),
        ) {
            let staging_root = match default_staging_root() {
                Some(p) => p,
                None => {
                    if let Some(splash) = app.get_webview_window(&splash_label) {
                        let _ = splash.eval(
                            "window.__showError('Could not resolve staging directory')",
                        );
                    }
                    show_main(&app, &splash_label);
                    return;
                }
            };
            let stage = tokio::time::timeout(
                std::time::Duration::from_secs(300),
                stage_update(
                    &update_info.latest_version,
                    bundle_url,
                    bundle_sha,
                    bundle_sig,
                    &staging_root,
                ),
            )
            .await;

            match stage {
                Ok(Ok(_)) => {
                    log::info!(
                        "updater: staged v{}, awaiting user restart",
                        update_info.latest_version
                    );
                    if let Some(splash) = app.get_webview_window(&splash_label) {
                        let v = update_info.latest_version.replace('\'', "\\'");
                        let _ = splash.eval(&format!(
                            "window.__showUpdateReady('{v}')"
                        ));
                    }
                    return;
                }
                Ok(Err(e)) => {
                    let msg = e.replace('\'', "\\'");
                    if let Some(splash) = app.get_webview_window(&splash_label) {
                        let _ = splash.eval(&format!(
                            "window.__showError('Stage failed: {msg}')"
                        ));
                    }
                    match rx.recv() {
                        Ok(m) if m == "retry" => continue,
                        _ => {
                            show_main(&app, &splash_label);
                            return;
                        }
                    }
                }
                Err(_) => {
                    if let Some(splash) = app.get_webview_window(&splash_label) {
                        let _ = splash.eval(
                            "window.__showError('Download timed out (5 min)')",
                        );
                    }
                    match rx.recv() {
                        Ok(m) if m == "retry" => continue,
                        _ => {
                            show_main(&app, &splash_label);
                            return;
                        }
                    }
                }
            }
        }

        // ── Legacy NSIS install path (first-install only) ───────────
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

    fn sha256_hex(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        hex::encode(hasher.finalize())
    }

    fn tokio_runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build test runtime")
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

    #[test]
    fn stage_succeeds_with_valid_inputs() {
        let runtime = tokio_runtime();
        runtime.block_on(async {
            let staging = tempfile::tempdir().unwrap();
            let staging_root = staging.path();

            let signing = fresh_keypair();
            let payload = b"PK fake app bundle v0.1.35\n".repeat(64);
            let sha = sha256_hex(&payload);
            let sig = signing.sign(&payload);
            let sig_b64 = b64(&sig.to_bytes());

            let final_path = stage_update_with_key(
                "0.1.35",
                &payload,
                &sha,
                &sig_b64,
                staging_root,
                &signing.verifying_key(),
            )
            .await
            .expect("valid signed payload must stage cleanly");

            assert!(final_path.exists(), "app.zip must exist on success");
            assert!(
                final_path.ends_with("app.zip"),
                "final path must end with app.zip"
            );
            assert_eq!(
                std::fs::read(&final_path).unwrap(),
                payload,
                "staged bytes must match input bytes"
            );

            let marker_path = staging_root.join("pending_update.json");
            assert!(marker_path.exists(), "marker must be written");
            let marker_text = std::fs::read_to_string(&marker_path).unwrap();
            let marker: PendingUpdate =
                serde_json::from_str(&marker_text).expect("marker must parse as PendingUpdate");
            assert_eq!(marker.version, "0.1.35");
            assert_eq!(marker.sha256, sha);
            assert!(
                marker.signature_verified,
                "marker must record signature_verified=true"
            );
            assert!(marker.staged_at_unix > 0, "staged_at_unix must be set");
            assert_eq!(marker.staging_path, final_path);
        });
    }

    #[test]
    fn stage_fails_on_sha256_mismatch() {
        let runtime = tokio_runtime();
        runtime.block_on(async {
            let staging = tempfile::tempdir().unwrap();
            let staging_root = staging.path();

            let signing = fresh_keypair();
            let payload = b"payload that will not match claimed hash";
            let wrong_sha = "0".repeat(64);
            let sig = signing.sign(payload);
            let sig_b64 = b64(&sig.to_bytes());

            let result = stage_update_with_key(
                "0.1.35",
                payload,
                &wrong_sha,
                &sig_b64,
                staging_root,
                &signing.verifying_key(),
            )
            .await;

            assert!(result.is_err(), "sha256 mismatch must fail");
            assert!(
                result.unwrap_err().contains("SHA-256"),
                "error must mention SHA-256"
            );

            let version_dir = staging_root.join("0.1.35");
            assert!(
                !version_dir.join("app.zip.tmp").exists(),
                "tmp file must be removed on failure"
            );
            assert!(
                !staging_root.join("pending_update.json").exists(),
                "no marker must be written on failure"
            );
        });
    }

    #[test]
    fn stage_fails_on_sig_mismatch() {
        let runtime = tokio_runtime();
        runtime.block_on(async {
            let staging = tempfile::tempdir().unwrap();
            let staging_root = staging.path();

            let legitimate = fresh_keypair();
            let attacker = fresh_keypair();

            let payload = b"payload signed by attacker, not by production CI";
            let sha = sha256_hex(payload);
            let bad_sig = attacker.sign(payload);
            let bad_sig_b64 = b64(&bad_sig.to_bytes());

            let result = stage_update_with_key(
                "0.1.35",
                payload,
                &sha,
                &bad_sig_b64,
                staging_root,
                &legitimate.verifying_key(),
            )
            .await;

            assert!(result.is_err(), "foreign-key signature must fail");
            assert!(
                result.unwrap_err().contains("signature"),
                "error must mention signature"
            );

            let version_dir = staging_root.join("0.1.35");
            assert!(!version_dir.join("app.zip.tmp").exists());
            assert!(!staging_root.join("pending_update.json").exists());
        });
    }

    #[test]
    fn stage_cleans_up_on_retry() {
        let runtime = tokio_runtime();
        runtime.block_on(async {
            let staging = tempfile::tempdir().unwrap();
            let staging_root = staging.path();

            let signing = fresh_keypair();

            let payload_v1 = b"first version".to_vec();
            let sha_v1 = sha256_hex(&payload_v1);
            let sig_v1 = signing.sign(&payload_v1);
            let sig_v1_b64 = b64(&sig_v1.to_bytes());
            stage_update_with_key(
                "0.1.35",
                &payload_v1,
                &sha_v1,
                &sig_v1_b64,
                staging_root,
                &signing.verifying_key(),
            )
            .await
            .expect("first stage must succeed");

            let final_v1 = staging_root.join("0.1.35").join("app.zip");
            assert!(final_v1.exists());

            let payload_v2 = b"second version with more bytes".repeat(8);
            let sha_v2 = sha256_hex(&payload_v2);
            let sig_v2 = signing.sign(&payload_v2);
            let sig_v2_b64 = b64(&sig_v2.to_bytes());
            let final_v2 = stage_update_with_key(
                "0.1.35",
                &payload_v2,
                &sha_v2,
                &sig_v2_b64,
                staging_root,
                &signing.verifying_key(),
            )
            .await
            .expect("second stage must succeed");

            assert_eq!(
                std::fs::read(&final_v2).unwrap(),
                payload_v2,
                "second stage must overwrite first"
            );
            assert!(!staging_root.join("0.1.35").join("app.zip.tmp").exists());

            let marker: PendingUpdate = serde_json::from_str(
                &std::fs::read_to_string(staging_root.join("pending_update.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(marker.sha256, sha_v2);
        });
    }

    // --- apply_pending_update tests (US-004) ---

    use std::io::Write;

    fn make_test_zip(dest_zip: &Path, entries: &[(&str, &[u8])]) {
        let file = std::fs::File::create(dest_zip).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts: zip::write::SimpleFileOptions =
            zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, data) in entries {
            zip.start_file(*name, opts).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
    }

    fn write_marker(staging_root: &Path, marker: &PendingUpdate) {
        std::fs::write(
            staging_root.join("pending_update.json"),
            serde_json::to_string(marker).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn apply_no_pending() {
        let install = tempfile::tempdir().unwrap();
        let staging = tempfile::tempdir().unwrap();
        let outcome = apply_pending_update(install.path(), "app.exe", staging.path());
        assert_eq!(outcome, ApplyOutcome::NoPending);
    }

    #[test]
    fn apply_corrupt_marker() {
        let install = tempfile::tempdir().unwrap();
        let staging = tempfile::tempdir().unwrap();
        std::fs::write(staging.path().join("pending_update.json"), b"{ not json").unwrap();

        let outcome = apply_pending_update(install.path(), "app.exe", staging.path());
        assert_eq!(outcome, ApplyOutcome::NoPending);
        assert!(
            !staging.path().join("pending_update.json").exists(),
            "corrupt marker must be deleted"
        );
    }

    #[test]
    fn apply_atomic_swap_succeeds() {
        let install = tempfile::tempdir().unwrap();
        let staging = tempfile::tempdir().unwrap();

        let current_exe = install.path().join("app.exe");
        std::fs::write(&current_exe, b"OLD VERSION PAYLOAD").unwrap();

        let version_dir = staging.path().join("0.1.35");
        std::fs::create_dir_all(&version_dir).unwrap();
        let zip_path = version_dir.join("app.zip");
        make_test_zip(&zip_path, &[("app.exe", b"NEW VERSION PAYLOAD")]);

        let marker = PendingUpdate {
            version: "0.1.35".into(),
            staging_path: zip_path,
            sha256: "deadbeef".into(),
            signature_verified: true,
            staged_at_unix: 1234567890,
        };
        write_marker(staging.path(), &marker);

        let outcome = apply_pending_update(install.path(), "app.exe", staging.path());
        assert_eq!(outcome, ApplyOutcome::Applied);

        let installed = std::fs::read(&current_exe).unwrap();
        assert_eq!(installed, b"NEW VERSION PAYLOAD");
        // On Windows the running exe may hold a handle to .bak; we accept either
        // .bak gone or .bak still present — next launch's crash-recovery skips
        // it because app.exe exists.
        assert!(!staging.path().join("pending_update.json").exists());
    }

    #[test]
    fn apply_crash_recovery_restores_bak() {
        let install = tempfile::tempdir().unwrap();
        let staging = tempfile::tempdir().unwrap();

        let bak = install.path().join("app.exe.bak");
        std::fs::write(&bak, b"OLD KNOWN-GOOD PAYLOAD").unwrap();

        let outcome = apply_pending_update(install.path(), "app.exe", staging.path());
        assert_eq!(outcome, ApplyOutcome::NoPending);
        assert!(
            install.path().join("app.exe").exists(),
            "crash recovery must restore .bak → app.exe"
        );
        assert_eq!(
            std::fs::read(install.path().join("app.exe")).unwrap(),
            b"OLD KNOWN-GOOD PAYLOAD"
        );
        assert!(!bak.exists(), "after restore, .bak must be gone");
    }

    #[test]
    fn platform_update_parses_with_bundle_fields() {
        let json = serde_json::json!({
            "key": "windows-x86_64",
            "url": "https://github.com/.../PaintKiDukaan_0.1.35_x64-setup.exe",
            "sha256": "aaaa",
            "size_bytes": 5_000_000u64,
            "bundle_url": "https://github.com/.../PaintKiDukaan_0.1.35_x64.zip",
            "ed25519_sig": "base64sig==",
            "bundle_sha256": "bbbb",
        });
        let parsed: PlatformUpdate =
            serde_json::from_value(json).expect("schema with bundle fields must parse");
        assert_eq!(parsed.key, "windows-x86_64");
        assert_eq!(parsed.url, "https://github.com/.../PaintKiDukaan_0.1.35_x64-setup.exe");
        assert_eq!(parsed.sha256, "aaaa");
        assert_eq!(parsed.size_bytes, 5_000_000);
        assert_eq!(
            parsed.bundle_url.as_deref(),
            Some("https://github.com/.../PaintKiDukaan_0.1.35_x64.zip")
        );
        assert_eq!(parsed.ed25519_sig.as_deref(), Some("base64sig=="));
        assert_eq!(parsed.bundle_sha256.as_deref(), Some("bbbb"));
    }

    #[test]
    fn platform_update_parses_legacy_without_bundle_fields() {
        let json = serde_json::json!({
            "key": "darwin-aarch64",
            "url": "https://github.com/.../PaintKiDukaan_0.1.34_aarch64.dmg",
            "sha256": "cccc",
            "size_bytes": 6_000_000u64,
        });
        let parsed: PlatformUpdate =
            serde_json::from_value(json).expect("legacy schema must still parse");
        assert_eq!(parsed.key, "darwin-aarch64");
        assert_eq!(parsed.url, "https://github.com/.../PaintKiDukaan_0.1.34_aarch64.dmg");
        assert!(parsed.bundle_url.is_none(), "legacy has no bundle_url");
        assert!(parsed.ed25519_sig.is_none(), "legacy has no ed25519_sig");
        assert!(parsed.bundle_sha256.is_none(), "legacy has no bundle_sha256");
    }

    // --- E2E integration test (US-009) ---
    // Tie stage_update + apply_pending_update together: stage a real signed
    // zip, then apply it to a fake install dir, verify the new payload lands.

    #[test]
    fn e2e_stage_then_apply_replaces_install() {
        let runtime = tokio_runtime();
        runtime.block_on(async {
            let install = tempfile::tempdir().unwrap();
            let staging = tempfile::tempdir().unwrap();

            std::fs::write(install.path().join("app.exe"), b"OLD VERSION").unwrap();

            let new_payload = b"NEW VERSION INSTALLED VIA SELF-UPDATE";
            let zip_path = staging.path().join("0.1.35").join("app.zip");
            std::fs::create_dir_all(zip_path.parent().unwrap()).unwrap();
            make_test_zip(&zip_path, &[("app.exe", new_payload)]);
            let zip_bytes = std::fs::read(&zip_path).unwrap();

            let signing = fresh_keypair();
            let sha = sha256_hex(&zip_bytes);
            let sig = signing.sign(&zip_bytes);
            let sig_b64 = b64(&sig.to_bytes());

            let staged = stage_update_with_key(
                "0.1.35",
                &zip_bytes,
                &sha,
                &sig_b64,
                staging.path(),
                &signing.verifying_key(),
            )
            .await
            .expect("stage must succeed");

            assert!(staged.exists());
            assert_eq!(staged, zip_path, "staged path must match the pre-built zip");

            let outcome = apply_pending_update(install.path(), "app.exe", staging.path());
            assert_eq!(outcome, ApplyOutcome::Applied);

            let installed = std::fs::read(install.path().join("app.exe")).unwrap();
            assert_eq!(
                installed, new_payload,
                "applied payload must match the entry inside the staged zip"
            );
        });
    }
}

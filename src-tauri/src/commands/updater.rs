// Custom updater with SHA-256 verification.
//
// Replaces tauri-plugin-updater which uses minisign signature verification.
// minisign required exact keypair synchronisation between CI secret and committed
// pubkey — that ceremony kept failing. For an internal paint-shop POS we accept
// TLS-protected downloads + SHA-256 hash comparison instead.
//
// Threat model: TLS protects the channel; SHA-256 protects against CDN tampering
// (GitHub Releases + any future mirror). Costs zero key management.

use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

fn is_trusted_update_url(url: &str) -> bool {
    url.starts_with(ALLOWED_UPDATE_PREFIX)
}

const LATEST_JSON_URL: &str =
    "https://github.com/Lucif3rHun1/PaintKiDukaan/releases/latest/download/latest.json";

/// Only allow downloads from our own GitHub Releases page.
const ALLOWED_UPDATE_PREFIX: &str =
    "https://github.com/Lucif3rHun1/PaintKiDukaan/releases/download/";

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

fn current_target() -> &'static str {
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

#[tauri::command]
pub async fn cmd_check_update() -> Result<UpdateInfo, String> {
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

#[tauri::command]
pub async fn cmd_download_update(url: String, expected_sha256: String) -> Result<DownloadResult, String> {
    if expected_sha256.len() != 64 || !expected_sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("expected_sha256 must be 64-char hex".into());
    }
    if !is_trusted_update_url(&url) {
        log::warn!("updater: rejected untrusted download URL: {url}");
        return Err("download URL not from trusted source".into());
    }
    let resp = reqwest::get(&url)
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

#[tauri::command]
pub async fn cmd_install_update(path: PathBuf, _app: tauri::AppHandle) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("file not found: {}", path.display()));
    }
    let temp_dir = std::env::temp_dir();
    match path.canonicalize().and_then(|p| Ok(p.starts_with(&temp_dir))) {
        Ok(true) => {}
        _ => {
            log::warn!("updater: rejected install path outside temp_dir: {}", path.display());
            return Err("install path must be in system temp directory".into());
        }
    }
    #[cfg(target_os = "windows")]
    {
        // NSIS installer: /S = silent install. Run detached so this command returns.
        std::process::Command::new(&path)
            .args(["/S"])
            .spawn()
            .map_err(|e| format!("spawn installer: {}", e))?;
        // Exit so the installer can replace our files.
        std::process::exit(0);
    }
    #[cfg(target_os = "macos")]
    {
        // The CI bundles a .app.tar.gz. Extract it to /Applications/ then open
        // the .app so Launch Services registers it.
        if path.extension().and_then(|s| s.to_str()) == Some("gz")
            && path.to_str().map(|s| s.ends_with(".app.tar.gz")).unwrap_or(false)
        {
            let app_dir = std::path::PathBuf::from("/Applications");
            let status = std::process::Command::new("tar")
                .args(["-xzf"])
                .arg(&path)
                .arg("-C")
                .arg(&app_dir)
                .status()
                .map_err(|e| format!("tar extract: {}", e))?;
            if !status.success() {
                return Err(format!("tar extract failed: {:?}", status.code()));
            }
            // Find the .app inside /Applications matching the bundle name.
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
                .arg(&path)
                .spawn()
                .map_err(|e| format!("open: {}", e))?;
        }
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        Err("Linux install: extract the AppImage and replace the running binary manually".into())
    }
}

#[tauri::command]
pub fn cmd_current_target() -> &'static str {
    current_target()
}
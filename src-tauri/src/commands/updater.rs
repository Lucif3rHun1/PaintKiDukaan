//! Thin IPC shim around tauri-plugin-updater.
//!
//! The plugin owns download, SHA-256 / Minisign verification, and install.
//! These commands exist only to keep the frontend IPC surface stable.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri_plugin_updater::UpdaterExt;

#[derive(Serialize, Deserialize)]
pub struct UpdateInfo {
    pub available: bool,
    pub current_version: String,
    pub latest_version: String,
    pub pub_date: Option<String>,
    pub notes: Option<String>,
    pub platforms: Vec<String>,
}

#[derive(Serialize, Deserialize)]
pub struct DownloadResult {
    pub path: PathBuf,
    pub bytes: u64,
    pub sha256: String,
}

static CACHED_UPDATE: Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>> = Mutex::new(None);

#[tauri::command]
pub async fn cmd_check_update(app: tauri::AppHandle) -> Result<UpdateInfo, String> {
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    Ok(match update {
        Some(u) => UpdateInfo {
            available: true,
            current_version: u.current_version,
            latest_version: u.version,
            pub_date: u.date.map(|d| d.to_string()),
            notes: u.body,
            platforms: vec![],
        },
        None => {
            let current = env!("CARGO_PKG_VERSION").to_string();
            UpdateInfo {
                available: false,
                current_version: current.clone(),
                latest_version: current,
                pub_date: None,
                notes: None,
                platforms: vec![],
            }
        }
    })
}

#[tauri::command]
pub async fn cmd_download_update(
    app: tauri::AppHandle,
    _url: String,
    _expected_sha256: String,
) -> Result<DownloadResult, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no update available".to_string())?;
    let bytes = update
        .download(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    let sha256 = hex::encode(Sha256::digest(&bytes));
    let result = DownloadResult {
        path: PathBuf::new(),
        bytes: bytes.len() as u64,
        sha256: sha256.clone(),
    };
    *CACHED_UPDATE.lock().unwrap() = Some((update, bytes));
    Ok(result)
}

#[tauri::command]
pub async fn cmd_install_update(_path: PathBuf, app: tauri::AppHandle) -> Result<(), String> {
    let (update, bytes) = CACHED_UPDATE
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| "no downloaded update".to_string())?;
    update.install(&bytes).map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub fn cmd_current_target() -> &'static str {
    static CACHE: OnceLock<String> = OnceLock::new();
    CACHE
        .get_or_init(|| tauri_plugin_updater::target().unwrap_or_else(|| "unknown".to_string()))
        .as_str()
}

#[tauri::command]
pub async fn cmd_retry_update(app: tauri::AppHandle) -> Result<(), String> {
    app.updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn cmd_quit_app(app: tauri::AppHandle) -> Result<(), String> {
    crate::graceful_shutdown(&app);
}

// audit(v0.2.0 HIGH #5, F6): best-effort write of the wipe-on-uninstall
// marker. The matching read path lives in `installer/hooks.nsh` — when
// this file is present, `HookPostUninstall` does `RMDir /r` of the app
// data dir on the way out. Marker filename MUST stay in sync with the
// NSH `${FileExists}` check.
const WIPE_MARKER_FILENAME: &str = "pkb-wipe-on-uninstall.marker";

pub fn write_wipe_marker(reason: &str) -> Result<(), String> {
    let dir = dirs::data_dir()
        .map(|p| p.join("in.paintkiduakan.master"))
        .ok_or_else(|| "no per-user data dir on this platform".to_string())?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    let path = dir.join(WIPE_MARKER_FILENAME);
    let body = format!("pkb-wipe-on-uninstall=1\nreason={reason}\n");
    std::fs::write(&path, body)
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_request_data_wipe(reason: String) -> Result<(), String> {
    write_wipe_marker(&reason)
}
use serde::{Deserialize, Serialize};
use std::process::Command;
#[cfg(target_os = "windows")]
use std::process::Stdio;
#[cfg(target_os = "windows")]
use std::thread;
#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

use crate::commands::auth::AppState;
use crate::error::AppResult;
#[cfg(target_os = "windows")]
use crate::error::AppError;
use crate::security::ipc_auth;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DiscoveredPrinter {
    pub name: String,
    pub driver_name: Option<String>,
    pub port_name: Option<String>,
    pub connection_type: String,
}

/// Spawn a PowerShell script and wait up to `timeout_secs` for completion.
/// Kills the process on timeout. Returns None on spawn failure / timeout / non-zero exit.
#[cfg(target_os = "windows")]
fn run_powershell(script: &str, timeout_secs: u64) -> Option<String> {
    let mut child = match Command::new(crate::sys_tool::resolve("powershell"))
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            log::warn!("run_powershell: spawn failed: {e}");
            return None;
        }
    };

    let deadline = Duration::from_secs(timeout_secs);
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => {
                if start.elapsed() >= deadline {
                    let _ = child.kill();
                    log::warn!("run_powershell: timed out after {timeout_secs}s");
                    return None;
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                log::warn!("run_powershell: try_wait error: {e}");
                let _ = child.kill();
                return None;
            }
        }
    };

    let status = status?;
    let output = child.wait_with_output().ok()?;
    if !status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::warn!("run_powershell: exit {status}: {stderr}");
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

// ── Type-based classification (primary signal) ──────────────────────────
//
// `Get-Printer` returns `Type` as a string enum (per MS docs):
//   Local | Logical | Connection | Network | Group | Shared | Internet
//   | PrintServer | PrintQueue | Fax | Service | Deferred
// Some hosts/CIM return it as a uint instead, so handle both.

#[cfg(target_os = "windows")]
fn classify_from_type(v: &Option<serde_json::Value>) -> Option<String> {
    let v = v.as_ref()?;
    if let Some(s) = v.as_str() {
        return match s.to_ascii_lowercase().as_str() {
            "local" | "logical" => Some("usb".into()),
            "network" | "connection" | "shared" | "internet" | "printserver" | "printqueue" => {
                Some("network".into())
            }
            "fax" => Some("unknown".into()),
            _ => None,
        };
    }
    if let Some(n) = v.as_i64() {
        return match n {
            3 | 5 => Some("usb".into()), // local / software
            4 => Some("network".into()),
            6 => Some("unknown".into()), // fax
            _ => None,
        };
    }
    None
}

#[cfg(target_os = "windows")]
fn classify_connection(port: &Option<String>, driver: &Option<String>) -> String {
    if let Some(p) = port {
        let pl = p.to_lowercase();
        if pl.contains("usb") || pl.starts_with("usb") || pl.contains("virtual") {
            return "usb".into();
        }
        if pl.contains("tcp") || pl.contains("ip_") || pl.contains("wsd") || pl.contains("http") {
            return "network".into();
        }
        if pl.contains("bt") || pl.contains("bluetooth") {
            return "bluetooth".into();
        }
    }
    if let Some(d) = driver {
        let dl = d.to_lowercase();
        if dl.contains("network") || dl.contains("tcp") || dl.contains("ip") {
            return "network".into();
        }
        if dl.contains("bluetooth") || dl.contains("bt") {
            return "bluetooth".into();
        }
        if dl.contains("usb") || dl.contains("xps") || dl.contains("pdf") {
            return "usb".into();
        }
    }
    "unknown".into()
}

#[cfg(target_os = "windows")]
fn classify_printer(
    type_field: &Option<serde_json::Value>,
    port: &Option<String>,
    driver: &Option<String>,
) -> String {
    classify_from_type(type_field).unwrap_or_else(|| classify_connection(port, driver))
}

#[cfg(target_os = "windows")]
fn mask_printer_name(name: &str) -> String {
    if name.contains('\\') || name.contains('/') {
        let parts: Vec<&str> = name.split(|c| c == '\\' || c == '/').collect();
        if parts.len() >= 2 {
            // UNC paths like \\SERVER\Printer split to ["", "", "SERVER", "Printer"]
            // Always mask both server and printer name for network paths
            return "***\\***".to_string();
        }
    }
    name.to_string()
}

#[cfg(target_os = "windows")]
const PS_TIMEOUT_SECS: u64 = 5;

// ── Raw JSON printer shared across Get-Printer and CIM ──────────────────

#[cfg(target_os = "windows")]
#[derive(Deserialize)]
struct RawPrinter {
    #[serde(rename = "Name")]
    name: Option<String>,
    #[serde(rename = "DriverName")]
    driver_name: Option<String>,
    #[serde(rename = "PortName")]
    port_name: Option<String>,
    #[serde(rename = "PrinterType", alias = "Type")]
    printer_type: Option<serde_json::Value>,
}

#[cfg(target_os = "windows")]
#[derive(Deserialize)]
struct Win32Printer {
    #[serde(rename = "Name")]
    name: Option<String>,
    #[serde(rename = "DriverName")]
    driver_name: Option<String>,
    #[serde(rename = "PortName")]
    port_name: Option<String>,
    #[serde(rename = "Network", default)]
    network: bool,
    #[serde(rename = "Local", default)]
    local: bool,
    #[serde(rename = "Shared", default)]
    shared: bool,
}

#[cfg(target_os = "windows")]
fn parse_printer_list(stdout: &str) -> Result<Vec<RawPrinter>, serde_json::Error> {
    let trimmed = stdout.trim();
    if trimmed.starts_with('[') {
        serde_json::from_str(trimmed)
    } else if trimmed.starts_with('{') {
        serde_json::from_str::<RawPrinter>(trimmed).map(|p| vec![p])
    } else {
        Ok(vec![])
    }
}

#[cfg(target_os = "windows")]
fn parse_win32_list(stdout: &str) -> Result<Vec<Win32Printer>, serde_json::Error> {
    let trimmed = stdout.trim();
    if trimmed.starts_with('[') {
        serde_json::from_str(trimmed)
    } else if trimmed.starts_with('{') {
        serde_json::from_str::<Win32Printer>(trimmed).map(|p| vec![p])
    } else {
        Ok(vec![])
    }
}

// ── Try Get-Printer (direct, no Start-Job) ─────────────────────────────

#[cfg(target_os = "windows")]
fn try_get_printer() -> Vec<DiscoveredPrinter> {
    let script = "try { \
        Get-Printer -ErrorAction Stop | \
        Select-Object Name, DriverName, PortName, PrinterType | \
        ConvertTo-Json -Depth 1 -Compress \
    } catch { '[]' }";

    let Some(stdout) = run_powershell(script, PS_TIMEOUT_SECS) else {
        return vec![];
    };

    match parse_printer_list(&stdout) {
        Ok(raw) => raw
            .into_iter()
            .filter_map(|p| {
                let name = p.name?;
                if name.is_empty() {
                    return None;
                }
                let connection_type =
                    classify_printer(&p.printer_type, &p.port_name, &p.driver_name);
                Some(DiscoveredPrinter {
                    name: mask_printer_name(&name),
                    driver_name: p.driver_name,
                    port_name: p.port_name,
                    connection_type,
                })
            })
            .collect(),
        Err(e) => {
            log::warn!("try_get_printer: json parse failed: {e}");
            vec![]
        }
    }
}

// ── Try Get-CimInstance Win32_Printer (more reliable than wmic) ────────

#[cfg(target_os = "windows")]
fn try_cim_discover() -> Vec<DiscoveredPrinter> {
    let script = "try { \
        Get-CimInstance -Class Win32_Printer -ErrorAction Stop | \
        Select-Object Name, DriverName, PortName, Network, Local, Shared | \
        ConvertTo-Json -Depth 1 -Compress \
    } catch { '[]' }";

    let Some(stdout) = run_powershell(script, PS_TIMEOUT_SECS) else {
        return vec![];
    };

    match parse_win32_list(&stdout) {
        Ok(list) => list
            .into_iter()
            .filter_map(|p| {
                let name = p.name?;
                if name.is_empty() {
                    return None;
                }
                let connection_type = if p.network || p.shared {
                    "network".into()
                } else if p.local {
                    "usb".into()
                } else {
                    classify_connection(&p.port_name, &p.driver_name)
                };
                Some(DiscoveredPrinter {
                    name: mask_printer_name(&name),
                    driver_name: p.driver_name,
                    port_name: p.port_name,
                    connection_type,
                })
            })
            .collect(),
        Err(e) => {
            log::warn!("try_cim_discover: json parse failed: {e}");
            vec![]
        }
    }
}

// ── macOS lpstat discovery ──────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn discover_macos_printers() -> AppResult<Vec<DiscoveredPrinter>> {
    let output = Command::new(crate::sys_tool::resolve("lpstat"))
        .arg("-p")
        .output()
        .ok()
        .filter(|o| o.status.success());

    let Some(out) = output else {
        return Ok(vec![]);
    };

    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut printers = Vec::new();

    for line in stdout.lines() {
        if !line.starts_with("printer ") {
            continue;
        }
        let rest = &line["printer ".len()..];
        let name = match rest.split_whitespace().next() {
            Some(n) if !n.is_empty() => n.to_string(),
            _ => continue,
        };
        printers.push(DiscoveredPrinter {
            name,
            driver_name: None,
            port_name: None,
            connection_type: "usb".into(),
        });
    }

    Ok(printers)
}

// ── Main discovery command ──────────────────────────────────────────────

#[tauri::command(rename_all = "snake_case")]
pub fn discover_system_printers(
    state: tauri::State<'_, AppState>,
) -> AppResult<Vec<DiscoveredPrinter>> {
    ipc_auth::authorize("discover_system_printers", state.inner())?;

    #[cfg(target_os = "macos")]
    {
        return discover_macos_printers();
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        log::warn!("discover_system_printers: not supported on this platform");
        return Ok(vec![]);
    }

    #[cfg(target_os = "windows")]
    {
        // Try Get-Printer first (richer: Type field); fall back to CIM (more compatible).
        let mut printers = try_get_printer();
        if printers.is_empty() {
            log::info!("discover_system_printers: Get-Printer returned empty, trying CIM");
            printers = try_cim_discover();
        }
        Ok(printers)
    }
}

// ── Printer status command ──────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod win32_printer_status {
    use std::ffi::c_void;

    type HANDLE = *mut c_void;
    type DWORD = u32;
    type BOOL = i32;

    const PRINTER_STATUS_PAUSED: u32 = 0x0000_0001;
    const PRINTER_STATUS_ERROR: u32 = 0x0000_0002;
    const PRINTER_STATUS_PENDING_DELETION: u32 = 0x0000_0004;
    const PRINTER_STATUS_PAPER_JAM: u32 = 0x0000_0008;
    const PRINTER_STATUS_PAPER_OUT: u32 = 0x0000_8000;
    const PRINTER_STATUS_OFFLINE: u32 = 0x0000_0020;
    const PRINTER_STATUS_IO_ACTIVE: u32 = 0x0000_0100;
    const PRINTER_STATUS_PRINTING: u32 = 0x0000_0200;
    const PRINTER_STATUS_BUSY: u32 = 0x0002_0000;
    const PRINTER_STATUS_DOOR_OPEN: u32 = 0x0040_0000;

    #[repr(C)]
    struct PrinterInfo2W {
        _p_server_name: *mut u16,
        p_printer_name: *mut u16,
        _p_share_name: *mut u16,
        _p_port_name: *mut u16,
        _p_driver_name: *mut u16,
        _p_comment: *mut u16,
        _p_location: *mut u16,
        _p_dev_mode: *mut c_void,
        _p_sep_file: *mut u16,
        _p_print_processor: *mut u16,
        _p_datatype: *mut u16,
        _p_parameters: *mut u16,
        _p_security_descriptor: *mut c_void,
        _attributes: DWORD,
        _priority: DWORD,
        _default_priority: DWORD,
        _start_time: DWORD,
        _until_time: DWORD,
        status: DWORD,
        _c_jobs: DWORD,
        _average_ppm: DWORD,
    }

    #[link(name = "winspool")]
    extern "system" {
        fn OpenPrinterW(
            p_printer_name: *const u16,
            ph_printer: *mut HANDLE,
            p_default: *mut c_void,
        ) -> BOOL;
        fn GetPrinterW(
            h_printer: HANDLE,
            level: DWORD,
            p_printer: *mut u8,
            cb_buf: DWORD,
            pcb_needed: *mut DWORD,
        ) -> BOOL;
        fn ClosePrinter(h_printer: HANDLE) -> BOOL;
    }

    pub fn query_status(printer_name: &str) -> Result<String, String> {
        let wide_name: Vec<u16> = printer_name
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

        let mut handle: HANDLE = std::ptr::null_mut();
        let ok = unsafe { OpenPrinterW(wide_name.as_ptr(), &mut handle, std::ptr::null_mut()) };
        if ok == 0 {
            return Err(format!("OpenPrinterW failed for '{}'", printer_name));
        }

        struct PrinterGuard(HANDLE);
        impl Drop for PrinterGuard {
            fn drop(&mut self) {
                if !self.0.is_null() {
                    unsafe { ClosePrinter(self.0) };
                }
            }
        }
        let _guard = PrinterGuard(handle);

        let mut needed: DWORD = 0;
        unsafe {
            GetPrinterW(handle, 2, std::ptr::null_mut(), 0, &mut needed);
        }

        if needed == 0 {
            return Err(format!(
                "GetPrinterW returned zero size for '{}'",
                printer_name
            ));
        }

        let mut buf: Vec<u8> = vec![0u8; needed as usize];
        let ok = unsafe { GetPrinterW(handle, 2, buf.as_mut_ptr(), needed, &mut needed) };
        if ok == 0 {
            return Err(format!("GetPrinterW failed for '{}'", printer_name));
        }

        let info = unsafe { &*(buf.as_ptr() as *const PrinterInfo2W) };
        Ok(classify_status_flags(info.status))
    }

    fn classify_status_flags(status: u32) -> String {
        if status == 0 {
            return "online".into();
        }
        if status & PRINTER_STATUS_PRINTING != 0 {
            return "printing".into();
        }
        if status & (PRINTER_STATUS_BUSY | PRINTER_STATUS_IO_ACTIVE) != 0 {
            return "busy".into();
        }
        if status & PRINTER_STATUS_ERROR != 0 {
            return "error".into();
        }
        if status & PRINTER_STATUS_DOOR_OPEN != 0 {
            return "door_open".into();
        }
        if status & PRINTER_STATUS_PAPER_JAM != 0 {
            return "paper_jam".into();
        }
        if status & PRINTER_STATUS_PAPER_OUT != 0 {
            return "paper_out".into();
        }
        if status & PRINTER_STATUS_OFFLINE != 0 {
            return "offline".into();
        }
        if status & PRINTER_STATUS_PAUSED != 0 {
            return "paused".into();
        }
        if status & PRINTER_STATUS_PENDING_DELETION != 0 {
            return "pending_deletion".into();
        }
        "busy".into()
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_printer_status(
    state: tauri::State<'_, AppState>,
    printer_name: String,
) -> AppResult<String> {
    ipc_auth::authorize("get_printer_status", state.inner())?;
    #[cfg(not(target_os = "windows"))]
    {
        let _ = printer_name;
        Ok("unknown".into())
    }
    #[cfg(target_os = "windows")]
    {
        match win32_printer_status::query_status(&printer_name) {
            Ok(s) => Ok(s),
            Err(e) => {
                log::warn!("get_printer_status: {e}");
                Err(AppError::Internal(e))
            }
        }
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    #[cfg(target_os = "windows")]
    use super::*;

    // ── classify_from_type (string enum, the actual shape Get-Printer returns) ──

    #[cfg(target_os = "windows")]
    #[test]
    fn classify_from_type_handles_string_enum() {
        assert_eq!(
            classify_from_type(&Some(serde_json::Value::String("Local".into()))),
            Some("usb".into())
        );
        assert_eq!(
            classify_from_type(&Some(serde_json::Value::String("Logical".into()))),
            Some("usb".into())
        );
        assert_eq!(
            classify_from_type(&Some(serde_json::Value::String("Network".into()))),
            Some("network".into())
        );
        assert_eq!(
            classify_from_type(&Some(serde_json::Value::String("Connection".into()))),
            Some("network".into())
        );
        assert_eq!(
            classify_from_type(&Some(serde_json::Value::String("Shared".into()))),
            Some("network".into())
        );
        assert_eq!(
            classify_from_type(&Some(serde_json::Value::String("Fax".into()))),
            Some("unknown".into())
        );
        assert_eq!(classify_from_type(&None), None);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn classify_from_type_handles_int_legacy() {
        // Some hosts report it as a uint (3=local, 4=network, 5=software, 6=fax)
        assert_eq!(
            classify_from_type(&Some(serde_json::json!(3))),
            Some("usb".into())
        );
        assert_eq!(
            classify_from_type(&Some(serde_json::json!(4))),
            Some("network".into())
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn classify_printer_prefers_type_over_heuristic() {
        // Type says Network but port looks USB → Type wins
        assert_eq!(
            classify_printer(
                &Some(serde_json::Value::String("Network".into())),
                &Some("USB001".into()),
                &None
            ),
            "network"
        );
        // Type says Local but port looks network → Type wins
        assert_eq!(
            classify_printer(
                &Some(serde_json::Value::String("Local".into())),
                &Some("TCP/IP".into()),
                &None
            ),
            "usb"
        );
        // No Type → falls back to heuristic
        assert_eq!(
            classify_printer(&None, &Some("USB001".into()), &None),
            "usb"
        );
    }

    // ── parse_printer_list (Get-Printer JSON shape) ────────────────────

    #[cfg(target_os = "windows")]
    #[test]
    fn parse_printer_list_handles_array() {
        let json = r#"[{"Name":"X","DriverName":"D","PortName":"USB001","PrinterType":"Local"}]"#;
        let list = parse_printer_list(json).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name.as_deref(), Some("X"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn parse_printer_list_handles_single_object() {
        let json = r#"{"Name":"X","DriverName":"D","PortName":"USB001","Type":"Local"}"#;
        let list = parse_printer_list(json).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name.as_deref(), Some("X"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn parse_printer_list_returns_empty_on_unknown() {
        assert!(parse_printer_list("hello").unwrap().is_empty());
        assert!(parse_printer_list("").unwrap().is_empty());
    }

    // ── Existing tests preserved ───────────────────────────────────────

    #[cfg(target_os = "windows")]
    #[test]
    fn mask_printer_name_masks_share_path() {
        assert_eq!(mask_printer_name("\\\\SERVER\\HP-LaserJet"), "***\\***");
        assert_eq!(mask_printer_name("//server/printer"), "***\\***");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn mask_printer_name_preserves_local_name() {
        assert_eq!(mask_printer_name("HP LaserJet Pro"), "HP LaserJet Pro");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn classify_connection_detects_network() {
        assert_eq!(
            classify_connection(&Some("TCP/IP".into()), &None),
            "network"
        );
        assert_eq!(
            classify_connection(&None, &Some("HP Network Driver".into())),
            "network"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn classify_connection_detects_usb() {
        assert_eq!(classify_connection(&Some("USB001".into()), &None), "usb");
    }
}

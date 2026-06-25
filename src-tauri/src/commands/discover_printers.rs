use serde::{Deserialize, Serialize};

use crate::commands::auth::AppState;
use crate::error::AppResult;
use crate::security::ipc_auth;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DiscoveredPrinter {
    pub name: String,
    pub driver_name: Option<String>,
    pub port_name: Option<String>,
    pub connection_type: String,
}

// ── Type-based classification (primary signal) ──────────────────────────

/// Map `Get-Printer` `Type` field integer to a connection type string.
/// Returns None when the value is absent or unrecognized (fallback will handle it).
#[cfg(target_os = "windows")]
fn classify_from_type(printer_type: Option<i64>) -> Option<String> {
    match printer_type {
        Some(3) => Some("usb".into()),     // local printer
        Some(4) => Some("network".into()), // network printer
        Some(5) => Some("usb".into()),     // software / PDF printer (local)
        Some(6) => Some("unknown".into()), // fax
        _ => None,                         // let fallback handle it
    }
}

/// Extract the integer value from the raw JSON `Type` field (may be number or string).
#[cfg(target_os = "windows")]
fn extract_printer_type(v: &Option<serde_json::Value>) -> Option<i64> {
    match v {
        Some(serde_json::Value::Number(n)) => n.as_i64(),
        Some(serde_json::Value::String(s)) => s.parse::<i64>().ok(),
        _ => None,
    }
}

/// Classify a printer: prefer the Type field, fall back to port/driver heuristics.
#[cfg(target_os = "windows")]
fn classify_printer(
    printer_type: Option<i64>,
    port: &Option<String>,
    driver: &Option<String>,
) -> String {
    if let Some(ct) = classify_from_type(printer_type) {
        return ct;
    }
    classify_connection(port, driver)
}

// ── Heuristic fallback (port / driver) ──────────────────────────────────

#[cfg(target_os = "windows")]
fn classify_connection(port: &Option<String>, driver: &Option<String>) -> String {
    if let Some(ref p) = port {
        let pl = p.to_lowercase();
        if pl.contains("usb") || pl.contains("virtual") || pl.starts_with("usb") {
            return "usb".into();
        }
        if pl.contains("tcp") || pl.contains("ip") || pl.contains("wsd") || pl.contains("http") {
            return "network".into();
        }
        if pl.contains("bt") || pl.contains("bluetooth") {
            return "bluetooth".into();
        }
    }
    if let Some(ref d) = driver {
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
fn mask_printer_name(name: &str) -> String {
    if name.contains('\\') || name.contains('/') {
        let parts: Vec<&str> = name.split(|c| c == '\\' || c == '/').collect();
        if parts.len() >= 2 {
            return format!("{}\\***", parts[0]);
        }
    }
    name.to_string()
}

#[cfg(target_os = "windows")]
const PS_TIMEOUT_SECS: u64 = 3;

// ── Raw JSON printer shared across Get-Printer and WMI ──────────────────

#[cfg(target_os = "windows")]
#[derive(Deserialize)]
struct RawPrinter {
    #[serde(rename = "Name")]
    name: Option<String>,
    #[serde(rename = "DriverName")]
    driver_name: Option<String>,
    #[serde(rename = "PortName")]
    port_name: Option<String>,
    #[serde(rename = "Type")]
    printer_type: Option<serde_json::Value>,
}

// ── WMIC fallback (wmic printer get ...) ────────────────────────────────

#[cfg(target_os = "windows")]
fn try_wmic_discover() -> Vec<DiscoveredPrinter> {
    use std::process::Command;
    use std::thread;
    use std::time::{Duration, Instant};

    const WMIC_TIMEOUT_SECS: u64 = 5;

    let mut child = match Command::new(crate::sys_tool::resolve("wmic"))
        .args(["printer", "get", "Name,PortName,DriverName", "/format:list"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            log::warn!("try_wmic_discover: failed to run wmic: {e}");
            return vec![];
        }
    };

    let timeout = Duration::from_secs(WMIC_TIMEOUT_SECS);
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    log::warn!("try_wmic_discover: wmic timed out after {WMIC_TIMEOUT_SECS}s");
                    return vec![];
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                log::warn!("try_wmic_discover: error waiting for wmic: {e}");
                let _ = child.kill();
                return vec![];
            }
        }
    };

    let output = match child.wait_with_output() {
        Ok(o) => o,
        Err(e) => {
            log::warn!("try_wmic_discover: failed to collect wmic output: {e}");
            return vec![];
        }
    };

    if !status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::warn!("try_wmic_discover: wmic exited with {status}: {}", stderr);
        return vec![];
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_wmic_output(&stdout)
}

#[cfg(target_os = "windows")]
fn parse_wmic_output(stdout: &str) -> Vec<DiscoveredPrinter> {
    let mut printers = Vec::new();
    let mut current_name: Option<String> = None;
    let mut current_port: Option<String> = None;
    let mut current_driver: Option<String> = None;

    fn flush(
        printers: &mut Vec<DiscoveredPrinter>,
        name: &mut Option<String>,
        port: &mut Option<String>,
        driver: &mut Option<String>,
    ) {
        if let Some(n) = name.take() {
            if !n.is_empty() {
                let connection_type = classify_connection(port, driver);
                printers.push(DiscoveredPrinter {
                    name: mask_printer_name(&n),
                    driver_name: driver.take(),
                    port_name: port.take(),
                    connection_type,
                });
                return;
            }
        }
        name.take();
        port.take();
        driver.take();
    }

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            flush(
                &mut printers,
                &mut current_name,
                &mut current_port,
                &mut current_driver,
            );
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            let key = key.trim();
            let value = value.trim();
            match key {
                "Name" => current_name = Some(value.to_string()),
                "PortName" => current_port = Some(value.to_string()),
                "DriverName" => current_driver = Some(value.to_string()),
                _ => {}
            }
        }
    }

    flush(
        &mut printers,
        &mut current_name,
        &mut current_port,
        &mut current_driver,
    );
    printers
}

// ── WMI fallback (Get-CimInstance Win32_Printer) ────────────────────────

#[cfg(target_os = "windows")]
fn try_wmi_discover() -> Vec<DiscoveredPrinter> {
    use std::process::Command;
    use std::time::Duration;

    let wmi_script = format!(
        "$job = Start-Job {{ Get-CimInstance -Class Win32_Printer | \
         Select-Object Name, DriverName, PortName, Type | ConvertTo-Json }}; \
         $done = Wait-Job $job -Timeout {PS_TIMEOUT_SECS}; \
         if ($done) {{ Receive-Job $job | ConvertTo-Json }} else {{ Stop-Job $job; '[]' }}",
    );

    let output = match Command::new(crate::sys_tool::resolve("powershell"))
        .args(["-NoProfile", "-NonInteractive", "-Command", &wmi_script])
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            log::warn!("try_wmi_discover: failed to run PowerShell: {e}");
            return vec![];
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::warn!(
            "try_wmi_discover: PowerShell exited with {}: {}",
            output.status,
            stderr
        );
        return vec![];
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stdout = stdout.trim();
    if stdout.is_empty() || stdout == "[]" {
        return vec![];
    }

    let raw_printers: Vec<RawPrinter> = if stdout.starts_with('[') {
        serde_json::from_str(stdout).unwrap_or_default()
    } else if stdout.starts_with('{') {
        serde_json::from_str::<RawPrinter>(stdout)
            .map(|p| vec![p])
            .unwrap_or_default()
    } else {
        log::warn!("try_wmi_discover: unexpected JSON format");
        return vec![];
    };

    raw_printers
        .into_iter()
        .filter_map(|p| {
            let name = p.name?;
            if name.is_empty() {
                return None;
            }
            let ptype = extract_printer_type(&p.printer_type);
            let connection_type = classify_printer(ptype, &p.port_name, &p.driver_name);
            Some(DiscoveredPrinter {
                name: mask_printer_name(&name),
                driver_name: p.driver_name,
                port_name: p.port_name,
                connection_type,
            })
        })
        .collect()
}

// ── macOS lpstat discovery ──────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn discover_macos_printers() -> AppResult<Vec<DiscoveredPrinter>> {
    use std::process::Command;

    let output = match Command::new(crate::sys_tool::resolve("lpstat")).arg("-p").output() {
        Ok(o) => o,
        Err(e) => {
            log::warn!("discover_macos_printers: lpstat failed: {e}");
            return Ok(vec![]);
        }
    };

    if !output.status.success() {
        log::warn!(
            "discover_macos_printers: lpstat exited with {}",
            output.status
        );
        return Ok(vec![]);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut printers = Vec::new();

    for line in stdout.lines() {
        // Lines look like: "printer HP-LaserJet is idle."
        if !line.starts_with("printer ") {
            continue;
        }
        let rest = &line["printer ".len()..];
        let name = match rest.split_whitespace().next() {
            Some(n) => n.to_string(),
            None => continue,
        };
        if name.is_empty() {
            continue;
        }

        // Try to get driver info from lpoptions
        let driver_name = Command::new(crate::sys_tool::resolve("lpoptions"))
            .args(["-p", &name, "-l"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .and_then(|raw| {
                // Look for a line containing "PageSize" as a driver hint
                raw.lines()
                    .find(|l| l.contains("PageSize") || l.contains("Resolution"))
                    .map(|_| name.clone())
            });

        printers.push(DiscoveredPrinter {
            name,
            driver_name,
            port_name: None,
            connection_type: "usb".into(), // default for direct-connected
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
        use std::process::Command;
        use std::time::Duration;

        let ps_script = format!(
            "$job = Start-Job {{ Get-Printer | Select-Object Name, DriverName, PortName, Type }}; \
             $done = Wait-Job $job -Timeout {PS_TIMEOUT_SECS}; \
             if ($done) {{ Receive-Job $job | ConvertTo-Json }} else {{ Stop-Job $job; '[]' }}",
        );

        let output = match Command::new(crate::sys_tool::resolve("powershell"))
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps_script])
            .output()
        {
            Ok(o) => o,
            Err(e) => {
                log::warn!("discover_system_printers: failed to run PowerShell, trying wmic: {e}");
                let mut printers = try_wmic_discover();
                if printers.is_empty() {
                    printers = try_wmi_discover();
                }
                return Ok(printers);
            }
        };

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            log::warn!(
                "discover_system_printers: Get-Printer exited with {}, falling back to wmic: {}",
                output.status,
                stderr
            );
            let mut printers = try_wmic_discover();
            if printers.is_empty() {
                printers = try_wmi_discover();
            }
            return Ok(printers);
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stdout = stdout.trim();
        if stdout.is_empty() || stdout == "[]" {
            log::info!("discover_system_printers: Get-Printer returned empty, trying wmic");
            let mut printers = try_wmic_discover();
            if printers.is_empty() {
                printers = try_wmi_discover();
            }
            return Ok(printers);
        }

        let raw_printers: Vec<RawPrinter> = if stdout.starts_with('[') {
            serde_json::from_str(stdout).unwrap_or_default()
        } else if stdout.starts_with('{') {
            serde_json::from_str::<RawPrinter>(stdout)
                .map(|p| vec![p])
                .unwrap_or_default()
        } else {
            log::warn!("discover_system_printers: unexpected JSON, trying wmic");
            let mut printers = try_wmic_discover();
            if printers.is_empty() {
                printers = try_wmi_discover();
            }
            return Ok(printers);
        };

        if raw_printers.is_empty() {
            log::info!(
                "discover_system_printers: parsed zero printers from Get-Printer, trying wmic"
            );
            let mut printers = try_wmic_discover();
            if printers.is_empty() {
                printers = try_wmi_discover();
            }
            return Ok(printers);
        }

        let printers: Vec<DiscoveredPrinter> = raw_printers
            .into_iter()
            .filter_map(|p| {
                let name = p.name?;
                if name.is_empty() {
                    return None;
                }
                let ptype = extract_printer_type(&p.printer_type);
                let connection_type = classify_printer(ptype, &p.port_name, &p.driver_name);
                Some(DiscoveredPrinter {
                    name: mask_printer_name(&name),
                    driver_name: p.driver_name,
                    port_name: p.port_name,
                    connection_type,
                })
            })
            .collect();

        Ok(printers)
    }
}

// ── Printer status command ──────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod win32_printer_status {
    type HANDLE = *mut std::ffi::c_void;
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
        p_server_name: *mut u16,
        p_printer_name: *mut u16,
        p_share_name: *mut u16,
        p_port_name: *mut u16,
        p_driver_name: *mut u16,
        p_comment: *mut u16,
        p_location: *mut u16,
        p_dev_mode: *mut std::ffi::c_void,
        p_sep_file: *mut u16,
        p_print_processor: *mut u16,
        p_datatype: *mut u16,
        p_parameters: *mut u16,
        p_security_descriptor: *mut std::ffi::c_void,
        attributes: DWORD,
        priority: DWORD,
        default_priority: DWORD,
        start_time: DWORD,
        until_time: DWORD,
        status: DWORD,
        c_jobs: DWORD,
        average_ppm: DWORD,
    }

    extern "system" {
        fn OpenPrinterW(
            p_printer_name: *const u16,
            ph_printer: *mut HANDLE,
            p_default: *mut std::ffi::c_void,
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

        // Ensure handle is closed on every exit path.
        struct PrinterGuard(HANDLE);
        impl Drop for PrinterGuard {
            fn drop(&mut self) {
                if !self.0.is_null() {
                    unsafe { ClosePrinter(self.0) };
                }
            }
        }
        let _guard = PrinterGuard(handle);

        // First call: get required buffer size.
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
        let status = info.status;

        Ok(classify_status_flags(status))
    }

    fn classify_status_flags(status: u32) -> String {
        if status == 0 {
            return "online".into();
        }
        // Priority: printing > busy > most-severe remaining
        if status & PRINTER_STATUS_PRINTING != 0 {
            return "printing".into();
        }
        if status & (PRINTER_STATUS_BUSY | PRINTER_STATUS_IO_ACTIVE) != 0 {
            return "busy".into();
        }
        // Pick the most severe remaining flag.
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
        // Fallback for any unrecognized flag combination.
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
                Err(crate::error::AppError::Internal(e))
            }
        }
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── classify_from_type ──────────────────────────────────────────────

    #[cfg(target_os = "windows")]
    #[test]
    fn classify_from_type_maps_known_types() {
        assert_eq!(classify_from_type(Some(3)), Some("usb".into()));
        assert_eq!(classify_from_type(Some(4)), Some("network".into()));
        assert_eq!(classify_from_type(Some(5)), Some("usb".into()));
        assert_eq!(classify_from_type(Some(6)), Some("unknown".into()));
        assert_eq!(classify_from_type(Some(99)), None);
        assert_eq!(classify_from_type(None), None);
    }

    // ── classify_printer ────────────────────────────────────────────────

    #[cfg(target_os = "windows")]
    #[test]
    fn classify_printer_prefers_type_over_heuristic() {
        // Type 4 = network, even if port looks USB
        assert_eq!(
            classify_printer(Some(4), &Some("USB001".into()), &None),
            "network"
        );
        // Type 3 = usb, even if port looks network
        assert_eq!(
            classify_printer(Some(3), &Some("TCP/IP".into()), &None),
            "usb"
        );
        // Type = None → falls back to heuristic
        assert_eq!(classify_printer(None, &Some("USB001".into()), &None), "usb");
    }

    // ── Existing tests (verbatim) ───────────────────────────────────────

    #[cfg(target_os = "windows")]
    use super::mask_printer_name;

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

use serde::{Deserialize, Serialize};

use crate::error::AppResult;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DiscoveredPrinter {
    pub name: String,
    pub driver_name: Option<String>,
    pub port_name: Option<String>,
    pub connection_type: String,
}

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

#[tauri::command(rename_all = "snake_case")]
pub fn discover_system_printers() -> AppResult<Vec<DiscoveredPrinter>> {
    #[cfg(not(target_os = "windows"))]
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

        let output = match Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps_script])
            .output()
        {
            Ok(o) => o,
            Err(e) => {
                log::warn!("discover_system_printers: failed to run PowerShell: {e}");
                return Ok(vec![]);
            }
        };

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            log::warn!(
                "discover_system_printers: PowerShell exited with {}: {}",
                output.status,
                stderr
            );
            return Ok(vec![]);
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stdout = stdout.trim();
        if stdout.is_empty() || stdout == "[]" {
            return Ok(vec![]);
        }

        #[derive(Deserialize)]
        struct RawPrinter {
            #[serde(rename = "Name")]
            name: Option<String>,
            #[serde(rename = "DriverName")]
            driver_name: Option<String>,
            #[serde(rename = "PortName")]
            port_name: Option<String>,
            #[serde(rename = "Type")]
            #[allow(dead_code)]
            printer_type: Option<serde_json::Value>,
        }

        let raw_printers: Vec<RawPrinter> = if stdout.starts_with('[') {
            serde_json::from_str(stdout).unwrap_or_default()
        } else if stdout.starts_with('{') {
            serde_json::from_str::<RawPrinter>(stdout)
                .map(|p| vec![p])
                .unwrap_or_default()
        } else {
            log::warn!("discover_system_printers: unexpected JSON format");
            return Ok(vec![]);
        };

        let printers: Vec<DiscoveredPrinter> = raw_printers
            .into_iter()
            .filter_map(|p| {
                let name = p.name?;
                if name.is_empty() {
                    return None;
                }
                let connection_type = classify_connection(&p.port_name, &p.driver_name);
                if connection_type == "network" {
                    return None;
                }
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

#[cfg(test)]
mod tests {
    #[cfg(target_os = "windows")]
    use super::*;

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

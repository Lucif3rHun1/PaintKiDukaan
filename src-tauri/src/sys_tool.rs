//! Absolute-path resolver for system tools to prevent PATH-hijack (CWE-426).
//!
//! Every `Command::new("powershell")` etc. should go through [`resolve`] so
//! the binary is loaded from a known-good system path, never from a
//! user-writable directory earlier on PATH.

use std::path::PathBuf;

/// Return the absolute path to a known system tool.
///
/// On Windows the path is derived from `SystemRoot` (default `C:\Windows`).
/// On macOS/Linux the path uses well-known FHS locations.
///
/// If the tool name is unrecognized, the raw name is returned unchanged
/// (preserves existing behavior for user-defined commands).
pub fn resolve(name: &str) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let sys = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        match name {
            "powershell" | "ps" => PathBuf::from(format!(
                r"{}\System32\WindowsPowerShell\v1.0\powershell.exe",
                sys
            )),
            "wmic" => PathBuf::from(format!(r"{}\System32\wbem\wmic.exe", sys)),
            "netstat" => PathBuf::from(format!(r"{}\System32\netstat.exe", sys)),
            "lpstat" => PathBuf::from(format!(r"{}\System32\spool\tools\lpstat.exe", sys)),
            "lpoptions" => PathBuf::from(format!(r"{}\System32\spool\tools\lpoptions.exe", sys)),
            "net" => PathBuf::from(format!(r"{}\System32\net.exe", sys)),
            "powercfg" => PathBuf::from(format!(r"{}\System32\powercfg.exe", sys)),
            "rundll32" => PathBuf::from(format!(r"{}\System32\rundll32.exe", sys)),
            _ => PathBuf::from(name),
        }
    }
    #[cfg(target_os = "macos")]
    {
        match name {
            "lpstat" => PathBuf::from("/usr/bin/lpstat"),
            "lpoptions" => PathBuf::from("/usr/sbin/lpoptions"),
            "ps" => PathBuf::from("/bin/ps"),
            "netstat" => PathBuf::from("/usr/sbin/netstat"),
            "ss" => PathBuf::from("/usr/sbin/ss"),
            "defaults" => PathBuf::from("/usr/bin/defaults"),
            "powercfg" | "net" | "wmic" | "rundll32" => {
                // Windows-only tools — should never be called on macOS.
                // Return the raw name so the caller gets a clear "not found" error.
                PathBuf::from(name)
            }
            _ => PathBuf::from(name),
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        // Linux / other Unix
        match name {
            "lpstat" => PathBuf::from("/usr/bin/lpstat"),
            "lpoptions" => PathBuf::from("/usr/sbin/lpoptions"),
            "ps" => PathBuf::from("/bin/ps"),
            "netstat" => PathBuf::from("/usr/sbin/netstat"),
            "ss" => PathBuf::from("/usr/sbin/ss"),
            _ => PathBuf::from(name),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_known_tools_returns_absolute() {
        for tool in &["ps", "lpstat"] {
            let p = resolve(tool);
            assert!(
                p.is_absolute(),
                "{tool} should resolve to absolute path, got {}",
                p.display()
            );
        }
    }

    #[test]
    fn resolve_unknown_returns_raw() {
        assert_eq!(resolve("custom-thing"), PathBuf::from("custom-thing"));
    }
}

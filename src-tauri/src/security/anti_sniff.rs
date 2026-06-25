//! Anti-sniff detection: PCAP drivers, analyzer processes, proxy environment
//! variables, loopback listeners.
//!
//! Each detection method accepts injectable helpers so tests never probe
//! the real OS.

use serde::Serialize;

// ─── Report ────────────────────────────────────────────────────────────────

/// Aggregated network-sniffing detection report.
#[derive(Clone, Debug, Default, Serialize)]
pub struct SniffReport {
    pub pcap_driver: bool,
    pub analyzer_process: bool,
    pub proxy_env: bool,
    pub loopback_listener: bool,
    pub evidence: Vec<String>,
}

// ─── Known analyzer process names (case-insensitive) ───────────────────────

const ANALYZER_PROCESSES: &[&str] = &[
    "fiddler.exe",
    "mitmproxy.exe",
    "wireshark.exe",
    "charles.exe",
    "burpsuite.exe",
    "httplook.exe",
    "httpdebugger.exe",
    // Also check without .exe for cross-platform compatibility.
    "fiddler",
    "mitmproxy",
    "wireshark",
    "charles",
    "burpsuite",
    "httplook",
    "httpdebugger",
    "burpsuite_pro",
];

// ─── Well-known loopback ports to ignore ───────────────────────────────────

const ALLOWED_LOOPBACK_PORTS: &[u16] = &[
    80,   // HTTP
    443,  // HTTPS
    8080, // HTTP alt
    8888, // HTTP debug
    1420, // Vite dev server (PaintKiDukaan)
    1421, // Vite HMR
    3000, // Common dev
    5173, // Vite default
    9222, // Chrome DevTools
];

// ─── Public API ────────────────────────────────────────────────────────────

/// Run all sniff-detection probes. Uses real OS calls.
pub fn detect() -> SniffReport {
    let mut report = SniffReport::default();

    // 1. PCAP driver (Windows).
    #[cfg(target_os = "windows")]
    if check_pcap_driver() {
        report.pcap_driver = true;
        report
            .evidence
            .push("PCAP driver (WinPcap/Npcap) service running".into());
    }

    // 2. Analyzer processes.
    let procs = get_process_names();
    if check_analyzer_processes(&procs) {
        report.analyzer_process = true;
        report
            .evidence
            .push("Network analyzer process detected".into());
    }

    // 3. Proxy environment variables.
    if check_proxy_env() {
        report.proxy_env = true;
        report
            .evidence
            .push("Proxy environment variable set".into());
    }

    // 4. Loopback listeners.
    let listeners = get_loopback_listeners();
    if check_loopback_listeners(&listeners) {
        report.loopback_listener = true;
        report
            .evidence
            .push("Suspicious loopback listener detected".into());
    }

    report
}

// ─── Testable pure-logic functions ─────────────────────────────────────────

/// Check if any process name matches a known analyzer.
pub fn check_analyzer_processes(process_names: &[String]) -> bool {
    process_names.iter().any(|name| {
        let lower = name.to_lowercase();
        ANALYZER_PROCESSES.iter().any(|&analyzer| lower == analyzer)
    })
}

/// Check if any suspicious proxy environment variable is set.
pub fn check_proxy_env() -> bool {
    let vars = &[
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
    ];
    vars.iter()
        .any(|var| std::env::var(var).ok().filter(|v| !v.is_empty()).is_some())
}

/// Check if loopback listeners exist on non-allowed ports.
pub fn check_loopback_listeners(listeners: &[LoopbackListener]) -> bool {
    listeners
        .iter()
        .any(|l| l.state == "LISTENING" && !ALLOWED_LOOPBACK_PORTS.contains(&l.port))
}

/// A loopback listener entry parsed from netstat output.
#[derive(Clone, Debug)]
pub struct LoopbackListener {
    pub port: u16,
    pub state: String,
}

// ─── Windows implementations ───────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod win {
    use std::ffi::c_void;

    // psapi.dll — EnumProcesses
    #[link(name = "psapi")]
    extern "system" {
        pub fn EnumProcesses(lpidProcess: *mut u32, cb: u32, lpcbNeeded: *mut u32) -> i32;
    }

    // kernel32 — process info
    #[link(name = "kernel32")]
    extern "system" {
        pub fn OpenProcess(
            dwDesiredAccess: u32,
            bInheritHandle: i32,
            dwProcessId: u32,
        ) -> *mut c_void;
        pub fn CloseHandle(hObject: *mut c_void) -> i32;
        pub fn QueryFullProcessImageNameW(
            hProcess: *mut c_void,
            dwFlags: u32,
            lpExeName: *mut u16,
            lpdwSize: *mut u32,
        ) -> i32;
    }

    // advapi32 — service enumeration
    #[link(name = "advapi32")]
    extern "system" {
        pub fn OpenSCManagerW(
            lpMachineName: *const u16,
            lpDatabaseName: *const u16,
            dwDesiredAccess: u32,
        ) -> *mut c_void;
        pub fn EnumServicesStatusW(
            hSCManager: *mut c_void,
            dwServiceType: u32,
            dwServiceState: u32,
            lpServices: *mut ENUM_SERVICE_STATUSW,
            cbBufSize: u32,
            pcbBytesNeeded: *mut u32,
            lpServicesReturned: *mut u32,
            lpResumeHandle: *mut u32,
        ) -> i32;
        pub fn CloseServiceHandle(hSCObject: *mut c_void) -> i32;
    }

    pub const PROCESS_QUERY_INFORMATION: u32 = 0x0400;
    pub const PROCESS_VM_READ: u32 = 0x0010;
    pub const SC_MANAGER_ENUMERATE_SERVICE: u32 = 0x0004;
    pub const SERVICE_WIN32: u32 = 0x0030;
    pub const SERVICE_ACTIVE: u32 = 0x0001;

    #[repr(C)]
    pub struct ENUM_SERVICE_STATUSW {
        pub lpServiceName: *mut u16,
        pub lpDisplayName: *mut u16,
        pub service_status: SERVICE_STATUS,
    }

    #[repr(C)]
    pub struct SERVICE_STATUS {
        pub dwServiceType: u32,
        pub dwCurrentState: u32,
        pub dwControlsAccepted: u32,
        pub dwWin32ExitCode: u32,
        pub dwServiceSpecificExitCode: u32,
        pub dwCheckPoint: u32,
        pub dwWaitHint: u32,
    }
}

#[cfg(target_os = "windows")]
fn check_pcap_driver() -> bool {
    unsafe {
        let scm = win::OpenSCManagerW(
            std::ptr::null(),
            std::ptr::null(),
            win::SC_MANAGER_ENUMERATE_SERVICE,
        );
        if scm.is_null() {
            return false;
        }

        let mut bytes_needed: u32 = 0;
        let mut services_returned: u32 = 0;
        let mut resume_handle: u32 = 0;

        // First call to get buffer size.
        win::EnumServicesStatusW(
            scm,
            win::SERVICE_WIN32,
            win::SERVICE_ACTIVE,
            std::ptr::null_mut(),
            0,
            &mut bytes_needed,
            &mut services_returned,
            &mut resume_handle,
        );

        if bytes_needed == 0 {
            win::CloseServiceHandle(scm);
            return false;
        }

        let count = (bytes_needed / std::mem::size_of::<win::ENUM_SERVICE_STATUSW>() as u32) + 10;
        let mut buffer: Vec<win::ENUM_SERVICE_STATUSW> = Vec::with_capacity(count as usize);
        buffer.set_len(count as usize);

        resume_handle = 0;
        let ret = win::EnumServicesStatusW(
            scm,
            win::SERVICE_WIN32,
            win::SERVICE_ACTIVE,
            buffer.as_mut_ptr(),
            bytes_needed + (10 * std::mem::size_of::<win::ENUM_SERVICE_STATUSW>() as u32),
            &mut bytes_needed,
            &mut services_returned,
            &mut resume_handle,
        );

        let mut found = false;
        if ret != 0 {
            for i in 0..services_returned as usize {
                let entry = &buffer[i];
                if !entry.lpServiceName.is_null() {
                    let name = wide_to_string(entry.lpServiceName);
                    let lower = name.to_lowercase();
                    if lower == "npf" || lower == "npcap" {
                        found = true;
                        break;
                    }
                }
            }
        }

        win::CloseServiceHandle(scm);
        found
    }
}

#[cfg(target_os = "windows")]
unsafe fn wide_to_string(ptr: *const u16) -> String {
    let mut len = 0;
    while *ptr.add(len) != 0 {
        len += 1;
    }
    let slice = std::slice::from_raw_parts(ptr, len);
    String::from_utf16_lossy(slice)
}

#[cfg(target_os = "windows")]
fn get_process_names() -> Vec<String> {
    let mut names = Vec::new();
    unsafe {
        let mut pids = vec![0u32; 4096];
        let mut needed: u32 = 0;
        if win::EnumProcesses(pids.as_mut_ptr(), (pids.len() * 4) as u32, &mut needed) == 0 {
            return names;
        }
        let count = needed as usize / 4;
        for &pid in &pids[..count] {
            if pid == 0 {
                continue;
            }
            let h = win::OpenProcess(
                win::PROCESS_QUERY_INFORMATION | win::PROCESS_VM_READ,
                0,
                pid,
            );
            if h.is_null() {
                continue;
            }
            let mut buf = vec![0u16; 512];
            let mut size = buf.len() as u32;
            if win::QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut size) != 0 {
                buf.set_len(size as usize);
                let full = String::from_utf16_lossy(&buf);
                if let Some(name) = std::path::Path::new(&full)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                {
                    names.push(name);
                }
            }
            win::CloseHandle(h);
        }
    }
    names
}

// ─── Unix implementations ──────────────────────────────────────────────────

#[cfg(not(target_os = "windows"))]
fn get_process_names() -> Vec<String> {
    // On Unix, use /proc or ps. Simplified: use ps command.
    let output = std::process::Command::new(crate::sys_tool::resolve("ps"))
        .args(["-eo", "comm="])
        .output();
    match output {
        Ok(out) => String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|l| {
                std::path::Path::new(l.trim())
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| l.trim().to_string())
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

// ─── Loopback listener detection ───────────────────────────────────────────

fn get_loopback_listeners() -> Vec<LoopbackListener> {
    let output = std::process::Command::new(crate::sys_tool::resolve("netstat"))
        .args(["-ano"])
        .output();
    match output {
        Ok(out) => parse_netstat_output(&String::from_utf8_lossy(&out.stdout)),
        Err(_) => {
            // Try ss on Linux.
            let output = std::process::Command::new(crate::sys_tool::resolve("ss"))
                .args(["-tlnp"])
                .output();
            match output {
                Ok(out) => parse_ss_output(&String::from_utf8_lossy(&out.stdout)),
                Err(_) => Vec::new(),
            }
        }
    }
}

/// Parse netstat -ano output for 127.0.0.1 LISTENING entries.
fn parse_netstat_output(output: &str) -> Vec<LoopbackListener> {
    let mut listeners = Vec::new();
    for line in output.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 5 {
            continue;
        }
        // Look for: TCP  127.0.0.1:PORT  0.0.0.0:0  LISTENING  PID
        if parts[0] != "TCP" {
            continue;
        }
        let local = parts[1];
        let state = parts[3];
        if state != "LISTENING" {
            continue;
        }
        if !local.starts_with("127.0.0.1:") {
            continue;
        }
        if let Some(port_str) = local.split(':').last() {
            if let Ok(port) = port_str.parse::<u16>() {
                listeners.push(LoopbackListener {
                    port,
                    state: state.to_string(),
                });
            }
        }
    }
    listeners
}

/// Parse ss -tlnp output for 127.0.0.1 LISTEN entries.
fn parse_ss_output(output: &str) -> Vec<LoopbackListener> {
    let mut listeners = Vec::new();
    for line in output.lines().skip(1) {
        // Skip header.
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 4 {
            continue;
        }
        let state = parts[0];
        if state != "LISTEN" {
            continue;
        }
        let local = parts[3];
        if !local.starts_with("127.0.0.1:") {
            continue;
        }
        if let Some(port_str) = local.split(':').last() {
            if let Ok(port) = port_str.parse::<u16>() {
                listeners.push(LoopbackListener {
                    port,
                    state: "LISTENING".to_string(),
                });
            }
        }
    }
    listeners
}

// ─── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_report_is_clean() {
        let r = SniffReport::default();
        assert!(!r.pcap_driver);
        assert!(!r.analyzer_process);
        assert!(!r.proxy_env);
        assert!(!r.loopback_listener);
        assert!(r.evidence.is_empty());
    }

    #[test]
    fn analyzer_detects_wireshark() {
        let procs = vec!["firefox.exe".into(), "wireshark.exe".into()];
        assert!(check_analyzer_processes(&procs));
    }

    #[test]
    fn analyzer_detects_fiddler() {
        let procs = vec!["Fiddler.exe".into()];
        assert!(check_analyzer_processes(&procs));
    }

    #[test]
    fn analyzer_detects_mitmproxy() {
        let procs = vec!["python3".into(), "mitmproxy".into()];
        assert!(check_analyzer_processes(&procs));
    }

    #[test]
    fn analyzer_clean_on_normal_procs() {
        let procs = vec![
            "firefox.exe".into(),
            "code.exe".into(),
            "paintkiduakan-master.exe".into(),
        ];
        assert!(!check_analyzer_processes(&procs));
    }

    #[test]
    fn analyzer_empty_list_is_clean() {
        let procs: Vec<String> = vec![];
        assert!(!check_analyzer_processes(&procs));
    }

    #[test]
    fn loopback_clean_on_allowed_port() {
        let listeners = vec![LoopbackListener {
            port: 1420,
            state: "LISTENING".into(),
        }];
        assert!(!check_loopback_listeners(&listeners));
    }

    #[test]
    fn loopback_detects_suspicious_port() {
        let listeners = vec![LoopbackListener {
            port: 12345,
            state: "LISTENING".into(),
        }];
        assert!(check_loopback_listeners(&listeners));
    }

    #[test]
    fn loopback_ignores_non_listening() {
        let listeners = vec![LoopbackListener {
            port: 12345,
            state: "ESTABLISHED".into(),
        }];
        assert!(!check_loopback_listeners(&listeners));
    }

    #[test]
    fn loopback_empty_is_clean() {
        let listeners: Vec<LoopbackListener> = vec![];
        assert!(!check_loopback_listeners(&listeners));
    }

    #[test]
    fn parse_netstat_finds_loopback_listener() {
        let input = "\
  TCP    127.0.0.1:1420         0.0.0.0:0              LISTENING       1234
  TCP    127.0.0.1:54321        0.0.0.0:0              LISTENING       5678
  TCP    192.168.1.1:80         0.0.0.0:0              LISTENING       9999
  TCP    127.0.0.1:80           0.0.0.0:0              ESTABLISHED     1111";
        let listeners = parse_netstat_output(input);
        assert_eq!(listeners.len(), 2);
        assert!(listeners.iter().any(|l| l.port == 1420));
        assert!(listeners.iter().any(|l| l.port == 54321));
    }

    #[test]
    fn parse_ss_finds_loopback_listener() {
        let input = "\
State    Recv-Q    Send-Q       Local Address:Port       Peer Address:Port
LISTEN   0         128              127.0.0.1:1420            0.0.0.0:*
LISTEN   0         128              127.0.0.1:9999            0.0.0.0:*";
        let listeners = parse_ss_output(input);
        assert_eq!(listeners.len(), 2);
        assert!(listeners.iter().any(|l| l.port == 1420));
        assert!(listeners.iter().any(|l| l.port == 9999));
    }

    #[test]
    fn sniff_report_serializes() {
        let r = SniffReport {
            pcap_driver: true,
            evidence: vec!["test".into()],
            ..Default::default()
        };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("pcap_driver"));
    }
}

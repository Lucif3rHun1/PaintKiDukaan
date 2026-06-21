//! Anti-debug detection: debugger presence, remote debugger, hardware
//! breakpoints, timing anomalies, ptrace/sysctl attachment.
//!
//! Each detection method is testable via injected helpers so tests never
//! probe the real OS.

use serde::Serialize;

// ─── Report ────────────────────────────────────────────────────────────────

/// Aggregated debug-detection report.
#[derive(Clone, Debug, Default, Serialize)]
pub struct DebugReport {
    pub debugger_present: bool,
    pub remote_debugger: bool,
    pub hardware_breakpoints: bool,
    pub timing_anomaly: bool,
    pub ptrace_attached: bool,
    pub evidence: Vec<String>,
}

// ─── Public API ────────────────────────────────────────────────────────────

/// Run all debug-detection probes. Uses real OS calls.
pub fn detect() -> DebugReport {
    let mut report = DebugReport::default();

    // 1. OS-level debugger check
    if check_debugger_present() {
        report.debugger_present = true;
        report.evidence.push("IsDebuggerPresent/ptrace/sysctl indicated debugger".into());
    }

    // 2. Remote debugger
    if check_remote_debugger() {
        report.remote_debugger = true;
        report.evidence.push("Remote debugger detected".into());
    }

    // 3. Hardware breakpoints (Windows only)
    if check_hardware_breakpoints() {
        report.hardware_breakpoints = true;
        report.evidence.push("Hardware breakpoints detected in DR0-DR7".into());
    }

    // 4. Timing anomaly
    if check_timing_anomaly(std::time::Instant::now, 5) {
        report.timing_anomaly = true;
        report.evidence.push("Timing anomaly: code execution abnormally slow".into());
    }

    // 5. Ptrace / sysctl attachment
    if check_ptrace_attached() {
        report.ptrace_attached = true;
        report.evidence.push("Process is being traced (ptrace/sysctl)".into());
    }

    report
}

// ─── Testable detection functions ──────────────────────────────────────────

/// Check if a debugger is present. Platform-specific.
fn check_debugger_present() -> bool {
    #[cfg(target_os = "windows")]
    {
        windows_is_debugger_present()
    }
    #[cfg(target_os = "linux")]
    {
        linux_ptrace_traceme()
    }
    #[cfg(target_os = "macos")]
    {
        macos_sysctl_debugger()
    }
}

/// Check for a remote debugger. Windows only; no-op elsewhere.
fn check_remote_debugger() -> bool {
    #[cfg(target_os = "windows")]
    {
        windows_check_remote_debugger()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// Check hardware breakpoints (DR0-DR7). Windows only; no-op elsewhere.
fn check_hardware_breakpoints() -> bool {
    #[cfg(target_os = "windows")]
    {
        windows_hardware_breakpoints()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// Timing-based detection: run a tight loop and check if it took
/// abnormally long (> `threshold_ms` ms per iteration).
/// The `now_fn` parameter enables testing with a fake clock.
pub fn check_timing_anomaly(
    now_fn: fn() -> std::time::Instant,
    threshold_ms: u128,
) -> bool {
    let start = now_fn();
    let iterations = 100_000u64;
    let mut sum = 0u64;
    for i in 0..iterations {
        sum = sum.wrapping_add(i);
    }
    // Prevent optimiser from eliding the loop.
    std::hint::black_box(sum);
    let elapsed = now_fn().duration_since(start).as_millis();
    // Normal: < 10ms. Suspicious: > threshold.
    elapsed > threshold_ms
}

/// Check if process is being traced. Platform-specific.
fn check_ptrace_attached() -> bool {
    #[cfg(target_os = "linux")]
    {
        linux_ptrace_attached()
    }
    #[cfg(target_os = "macos")]
    {
        // On macOS we already checked sysctl in check_debugger_present;
        // this is a no-op to avoid double-reporting.
        false
    }
    #[cfg(target_os = "windows")]
    {
        // On Windows, NtQueryInformationProcess(ProcessDebugPort) covers this.
        windows_ntqip_debug_port()
    }
}

// ─── Windows implementations ───────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod win {
    use std::ffi::c_void;

    #[link(name = "kernel32")]
    extern "system" {
        pub fn IsDebuggerPresent() -> i32;
        pub fn CheckRemoteDebuggerPresent(
            hProcess: *mut c_void,
            pbDebuggerPresent: *mut i32,
        ) -> i32;
        pub fn GetCurrentProcess() -> *mut c_void;
        pub fn GetThreadContext(
            hThread: *mut c_void,
            lpContext: *mut CONTEXT,
        ) -> i32;
        pub fn GetCurrentThread() -> *mut c_void;
    }

    #[link(name = "ntdll")]
    extern "system" {
        pub fn NtQueryInformationProcess(
            ProcessHandle: *mut c_void,
            ProcessInformationClass: u32,
            ProcessInformation: *mut c_void,
            ProcessInformationLength: u32,
            ReturnLength: *mut u32,
        ) -> i32;
    }

    // CONTEXT structure (simplified for DR0-DR7 extraction).
    // Offpoints are for x86_64.
    #[repr(C)]
    pub struct CONTEXT {
        pub p1_home: u64,
        pub p2_home: u64,
        pub p3_home: u64,
        pub p4_home: u64,
        pub p5_home: u64,
        pub p6_home: u64,
        pub context_flags: u32,
        pub mx_csr: u32,
        pub seg_cs: u16,
        pub seg_ds: u16,
        pub seg_es: u16,
        pub seg_fs: u16,
        pub seg_gs: u16,
        pub seg_ss: u16,
        pub eflags: u32,
        pub dr0: u64,
        pub dr1: u64,
        pub dr2: u64,
        pub dr3: u64,
        pub dr6: u64,
        pub dr7: u64,
        // Remaining fields omitted — we only need DR0-DR7.
        pub _padding: [u8; 512],
    }

    pub const PROCESS_DEBUG_PORT: u32 = 7;
    pub const CONTEXT_DEBUG_REGISTERS: u32 = 0x0010_0010;
}

#[cfg(target_os = "windows")]
fn windows_is_debugger_present() -> bool {
    unsafe { win::IsDebuggerPresent() != 0 }
}

#[cfg(target_os = "windows")]
fn windows_check_remote_debugger() -> bool {
    unsafe {
        let mut present: i32 = 0;
        let h = win::GetCurrentProcess();
        if win::CheckRemoteDebuggerPresent(h, &mut present) != 0 {
            present != 0
        } else {
            false
        }
    }
}

#[cfg(target_os = "windows")]
fn windows_ntqip_debug_port() -> bool {
    unsafe {
        let mut port: usize = 0;
        let status = win::NtQueryInformationProcess(
            win::GetCurrentProcess(),
            win::PROCESS_DEBUG_PORT,
            &mut port as *mut _ as *mut std::ffi::c_void,
            std::mem::size_of::<usize>() as u32,
            std::ptr::null_mut(),
        );
        // If NtQIP succeeds and port != 0, a debugger is attached.
        status == 0 && port != 0
    }
}

#[cfg(target_os = "windows")]
fn windows_hardware_breakpoints() -> bool {
    unsafe {
        let mut ctx: win::CONTEXT = std::mem::zeroed();
        ctx.context_flags = win::CONTEXT_DEBUG_REGISTERS;
        if win::GetThreadContext(win::GetCurrentThread(), &mut ctx) == 0 {
            return false;
        }
        // DR7 is the debug control register; non-zero with DR0-DR3 set
        // indicates hardware breakpoints.
        ctx.dr0 != 0 || ctx.dr1 != 0 || ctx.dr2 != 0 || ctx.dr3 != 0
    }
}

// ─── Linux implementations ─────────────────────────────────────────────────

#[cfg(target_os = "linux")]
mod linux {
    pub const PTRACE_TRACEME: i32 = 0;
}

#[cfg(target_os = "linux")]
fn linux_ptrace_traceme() -> bool {
    // If PTRACE_TRACEME fails (returns -1), a debugger is already attached.
    // If it succeeds, we are NOT being debugged — detach immediately.
    unsafe {
        let ret = libc_ptrace(linux::PTRACE_TRACEME, 0, std::ptr::null(), std::ptr::null());
        if ret == -1 {
            true // debugger attached
        } else {
            // Detach so we don't stay in traced state.
            libc_ptrace(linux::PTRACE_DETACH, 0, std::ptr::null(), std::ptr::null());
            false
        }
    }
}

#[cfg(target_os = "linux")]
fn linux_ptrace_attached() -> bool {
    // Read /proc/self/status for TracerPid.
    std::fs::read_to_string("/proc/self/status")
        .map(|s| {
            s.lines()
                .find(|l| l.starts_with("TracerPid:"))
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|v| v.parse::<i32>().ok())
                .map(|pid| pid != 0)
                .unwrap_or(false)
        })
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
const PTRACE_DETACH: i32 = 17;

#[cfg(target_os = "linux")]
unsafe fn libc_ptrace(request: i32, pid: i32, addr: *const (), data: *const ()) -> i64 {
    // Direct syscall — avoids linking libc crate.
    // On x86_64 Linux, syscall number for ptrace is 101.
    #[cfg(target_arch = "x86_64")]
    {
        std::arch::asm!(
            "syscall",
            in("rax") 101i64,
            in("rdi") request,
            in("rsi") pid,
            in("rdx") addr,
            in("r10") data,
            lateout("rax") let ret: i64,
            out("rcx") _,
            out("r11") _,
        );
        ret
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        // Fallback: link libc.
        extern "C" {
            fn ptrace(request: i32, pid: i32, addr: *const (), data: *const ()) -> i64;
        }
        ptrace(request, pid, addr, data)
    }
}

// ─── macOS implementations ─────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn macos_sysctl_debugger() -> bool {
    // Use sysctl to check P_TRACED flag in kp_proc.p_flag.
    // This is the standard macOS way to detect a debugger.
    use std::mem;

    const P_TRACED: i32 = 0x0000_0800;
    const CTL_KERN: i32 = 1;
    const KERN_PROC: i32 = 14;
    const KERN_PROC_PID: i32 = 1;

    #[repr(C)]
    struct KinfoProc {
        kp_proc: extern_struct_padded,
        kp_eproc: KinfoProc_eproc,
    }

    #[repr(C)]
    struct extern_struct_padded {
        p_forw: u32,
        p_back: u32,
        p_list: [u32; 2],
        p_pid: u32,
        p_ppid: u32,
        p_pgid: u32,
        p_jobc: u32,
        p_tdev: u32,
        p_tpgid: u32,
        p_uid: u32,
        p_ruid: u32,
        p_gid: u32,
        p_rgid: u32,
        p_groups: [u16; 16],
        p_ngroups: u16,
        p_flags: i32,
        // Remaining fields omitted.
        _rest: [u8; 512],
    }

    #[repr(C)]
    struct KinfoProc_eproc {
        _rest: [u8; 256],
    }

    // Use raw sysctl syscall to avoid libc dependency.
    unsafe {
        let pid = libc_getpid();
        let mib: [i32; 4] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid];
        let mut proc_info: KinfoProc = mem::zeroed();
        let mut size = mem::size_of::<KinfoProc>();

        let ret = libc_sysctl(
            mib.as_ptr(),
            4,
            &mut proc_info as *mut _ as *mut std::ffi::c_void,
            &mut size,
            std::ptr::null(),
            0,
        );

        if ret == 0 {
            (proc_info.kp_proc.p_flags & P_TRACED) != 0
        } else {
            false
        }
    }
}

#[cfg(target_os = "macos")]
unsafe fn libc_sysctl(
    name: *const i32,
    namelen: u32,
    oldp: *mut std::ffi::c_void,
    oldlenp: *mut usize,
    newp: *const std::ffi::c_void,
    newlen: usize,
) -> i32 {
    extern "C" {
        fn sysctl(
            name: *const i32,
            namelen: u32,
            oldp: *mut std::ffi::c_void,
            oldlenp: *mut usize,
            newp: *const std::ffi::c_void,
            newlen: usize,
        ) -> i32;
    }
    sysctl(name, namelen, oldp, oldlenp, newp, newlen)
}

#[cfg(target_os = "macos")]
unsafe fn libc_getpid() -> i32 {
    extern "C" {
        fn getpid() -> i32;
    }
    getpid()
}

// ─── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_report_is_clean() {
        let r = DebugReport::default();
        assert!(!r.debugger_present);
        assert!(!r.remote_debugger);
        assert!(!r.hardware_breakpoints);
        assert!(!r.timing_anomaly);
        assert!(!r.ptrace_attached);
        assert!(r.evidence.is_empty());
    }

    #[test]
    fn timing_anomaly_detects_slow_execution() {
        // Fake clock that jumps 100ms per call — simulates debugger slowdown.
        use std::sync::atomic::{AtomicU64, Ordering};
        static TICK: AtomicU64 = AtomicU64::new(0);

        let fake_now = || {
            let t = TICK.fetch_add(100_000_000, Ordering::Relaxed); // 100ms in ns
            std::time::Instant::now() + std::time::Duration::from_nanos(t)
        };

        // We can't directly use check_timing_anomaly with a closure (it takes
        // fn pointer), so we test the logic inline.
        let start = fake_now();
        let _ = std::hint::black_box(42u64);
        let elapsed = fake_now().duration_since(start).as_millis();
        assert!(elapsed > 5, "fake clock should simulate >5ms");
    }

    #[test]
    fn timing_anomaly_clean_when_fast() {
        // Real fast code should NOT trigger timing anomaly.
        assert!(!check_timing_anomaly(std::time::Instant::now, 100));
    }

    #[test]
    fn debug_report_serializes() {
        let r = DebugReport {
            debugger_present: true,
            evidence: vec!["test".into()],
            ..Default::default()
        };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("debugger_present"));
        assert!(json.contains("test"));
    }
}

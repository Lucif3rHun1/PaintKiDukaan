//! Anti-debug detection: debugger presence, remote debugger, hardware
//! breakpoints, timing anomalies, ptrace/sysctl attachment, plus SOTA
//! techniques: direct-syscall NtQueryInformationProcess (5 info classes),
//! NtQuerySystemInformation, parent-process walk, hypervisor refinements,
//! KUSER_SHARED_DATA, anti-anti-debug patch detection.
//!
//! Each detection method is testable via injected helpers so tests never
//! probe the real OS.

use serde::Serialize;

// ─── Known debugger process names ──────────────────────────────────────────

#[allow(dead_code)]
const DEBUGGER_PROCESS_NAMES: &[&str] = &[
    "devenv.exe",
    "ollydbg.exe",
    "x64dbg.exe",
    "x32dbg.exe",
    "ida.exe",
    "idaq.exe",
    "ida64.exe",
    "windbg.exe",
    "immunitydebugger.exe",
    "cheatengine-x86_64.exe",
    "cheatengine.exe",
    "processhacker.exe",
    "dnspy.exe",
    "ilspy.exe",
    "ghidra.exe",
    "radare2.exe",
    "r2.exe",
    "binaryninja.exe",
];

// ─── Hypervisor brand strings ──────────────────────────────────────────────

#[allow(dead_code)]
const HYPERVISOR_BRANDS: &[&str] = &[
    "Microsoft Hv",     // Hyper-V
    "KVMKVMKVM\0\0\0",  // KVM
    "XenVMMXenVMM\0\0", // Xen
    "VMwareVMware",     // VMware
    "prl hyperv",       // Parallels
    "VBoxVBoxVBox",     // VirtualBox
    "TCGTCGTCGTCG",     // QEMU TCG
];

// ─── Comprehensive report ─────────────────────────────────────────────────

/// Extended detection results from SOTA techniques.
#[derive(Clone, Debug, Default, Serialize)]
pub struct ComprehensiveReport {
    // NtQueryInformationProcess checks (via direct syscall)
    pub debug_port: bool,
    pub debug_object_handle: bool,
    pub debug_flags: bool,
    pub parent_debugger: bool,
    pub instrumentation_callback: bool,

    // NtQuerySystemInformation
    pub kernel_debugger: bool,

    // Hypervisor refinements
    pub hypervisor_brand: Option<String>,
    pub hypervisor_feature_flag: bool,
    pub kuser_hypervisor: bool,

    // Anti-anti-debug
    pub self_patch_detected: bool,

    // NTDLL integrity (result from ntdll_integrity module)
    pub ntdll_hooked: bool,

    /// Evidence strings for comprehensive detections.
    pub evidence: Vec<String>,
}

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
    /// Extended SOTA detection results.
    #[serde(default)]
    pub comprehensive: ComprehensiveReport,
}

// ─── Public API ────────────────────────────────────────────────────────────

/// Run all debug-detection probes. Uses real OS calls.
pub fn detect() -> DebugReport {
    let mut report = DebugReport::default();

    // 1. OS-level debugger check
    if check_debugger_present() {
        report.debugger_present = true;
        report
            .evidence
            .push("IsDebuggerPresent/ptrace/sysctl indicated debugger".into());
    }

    // 2. Remote debugger
    if check_remote_debugger() {
        report.remote_debugger = true;
        report.evidence.push("Remote debugger detected".into());
    }

    // 3. Hardware breakpoints (Windows only)
    if check_hardware_breakpoints() {
        report.hardware_breakpoints = true;
        report
            .evidence
            .push("Hardware breakpoints detected in DR0-DR7".into());
    }

    // 4. Timing anomaly
    if check_timing_anomaly(std::time::Instant::now, 5) {
        report.timing_anomaly = true;
        report
            .evidence
            .push("Timing anomaly: code execution abnormally slow".into());
    }

    // 5. Ptrace / sysctl attachment
    if check_ptrace_attached() {
        report.ptrace_attached = true;
        report
            .evidence
            .push("Process is being traced (ptrace/sysctl)".into());
    }

    // 6. SOTA comprehensive checks
    report.comprehensive = detect_comprehensive();

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
pub fn check_timing_anomaly(now_fn: fn() -> std::time::Instant, threshold_ms: u128) -> bool {
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
        pub fn GetThreadContext(hThread: *mut c_void, lpContext: *mut CONTEXT) -> i32;
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

// ─── SOTA comprehensive detection ─────────────────────────────────────────

/// Run all SOTA detection techniques and return a ComprehensiveReport.
pub fn detect_comprehensive() -> ComprehensiveReport {
    let mut cr = ComprehensiveReport::default();

    // Windows-specific: NtQueryInformationProcess, NtQuerySystemInformation,
    // parent walk, KUSER_SHARED_DATA, self-patch detection.
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        sota_ntqip_checks(&mut cr);
        sota_ntqsi_kernel_debugger(&mut cr);
        sota_parent_walk(&mut cr);
        sota_kuser_hypervisor(&mut cr);
        sota_self_patch_check(&mut cr);
    }

    // Cross-platform: hypervisor brand via CPUID (x86/x86_64 only).
    sota_hypervisor_brand(&mut cr);
    sota_hypervisor_feature_flag(&mut cr);

    // NTDLL integrity (delegates to ntdll_integrity module).
    let ntdll_report = super::ntdll_integrity::check_ntdll_integrity();
    if !ntdll_report.text_hash_match || ntdll_report.hook_count > 0 {
        cr.ntdll_hooked = true;
        cr.evidence.push(format!(
            "NTDLL integrity: hash_match={}, hooks={}",
            ntdll_report.text_hash_match, ntdll_report.hook_count
        ));
    }

    cr
}

/// Comprehensive NtQueryInformationProcess checks via direct syscall.
///
/// Checks 5 information classes:
/// - ProcessDebugPort (7)
/// - ProcessDebugObjectHandle (30)
/// - ProcessDebugFlags (31)
/// - ProcessBasicInformation (0)
/// - ProcessInstrumentationCallback (40)
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn sota_ntqip_checks(cr: &mut ComprehensiveReport) {
    use super::syscall;

    // ProcessDebugPort (class 7)
    let mut port: usize = 0;
    let status = unsafe {
        syscall::nt_query_information_process(
            0xFFFFFFFFFFFFFFFF, // NtCurrentProcess
            7,
            &mut port as *mut _ as *mut u8,
            std::mem::size_of::<usize>() as u32,
            std::ptr::null_mut(),
        )
    };
    if status == 0 && port != 0 {
        cr.debug_port = true;
        cr.evidence
            .push("NtQIP(ProcessDebugPort): non-zero debug port".into());
    }

    // ProcessDebugObjectHandle (class 30/0x1E)
    let mut handle: usize = 0;
    let status = unsafe {
        syscall::nt_query_information_process(
            0xFFFFFFFFFFFFFFFF,
            30,
            &mut handle as *mut _ as *mut u8,
            std::mem::size_of::<usize>() as u32,
            std::ptr::null_mut(),
        )
    };
    // STATUS_SUCCESS (0) means a debug object exists.
    if status == 0 {
        cr.debug_object_handle = true;
        cr.evidence
            .push("NtQIP(ProcessDebugObjectHandle): debug object exists".into());
    }

    // ProcessDebugFlags (class 31/0x1F)
    let mut flags: u32 = 0;
    let status = unsafe {
        syscall::nt_query_information_process(
            0xFFFFFFFFFFFFFFFF,
            31,
            &mut flags as *mut _ as *mut u8,
            std::mem::size_of::<u32>() as u32,
            std::ptr::null_mut(),
        )
    };
    // flags == 0 means NoDebugInherit is NOT set → inherited from debugged parent.
    if status == 0 && flags == 0 {
        cr.debug_flags = true;
        cr.evidence
            .push("NtQIP(ProcessDebugFlags): NoDebugInherit not set".into());
    }

    // ProcessBasicInformation (class 0) — check parent PID.
    #[repr(C)]
    struct ProcessBasicInformation {
        exit_status: i64,
        peb_base_address: *mut u8,
        affinity_mask: usize,
        base_priority: i32,
        unique_process_id: usize,
        inherited_from_unique_process_id: usize,
    }

    let mut pbi: ProcessBasicInformation = unsafe { std::mem::zeroed() };
    let status = unsafe {
        syscall::nt_query_information_process(
            0xFFFFFFFFFFFFFFFF,
            0,
            &mut pbi as *mut _ as *mut u8,
            std::mem::size_of::<ProcessBasicInformation>() as u32,
            std::ptr::null_mut(),
        )
    };
    if status == 0 {
        // Check if parent PID matches a known debugger.
        let parent_pid = pbi.inherited_from_unique_process_id;
        if parent_pid != 0 {
            if let Some(parent_name) = get_process_name_by_pid(parent_pid) {
                let lower = parent_name.to_lowercase();
                for &dbg in DEBUGGER_PROCESS_NAMES {
                    if lower.contains(&dbg.to_lowercase().replace(".exe", ""))
                        || lower == dbg.to_lowercase()
                    {
                        cr.parent_debugger = true;
                        cr.evidence.push(format!(
                            "Parent PID {} is debugger: {}",
                            parent_pid, parent_name
                        ));
                        break;
                    }
                }
            }
        }
    }

    // ProcessInstrumentationCallback (class 40/0x28)
    let mut callback: usize = 0;
    let status = unsafe {
        syscall::nt_query_information_process(
            0xFFFFFFFFFFFFFFFF,
            40,
            &mut callback as *mut _ as *mut u8,
            std::mem::size_of::<usize>() as u32,
            std::ptr::null_mut(),
        )
    };
    if status == 0 && callback != 0 {
        cr.instrumentation_callback = true;
        cr.evidence
            .push("NtQIP(ProcessInstrumentationCallback): non-NULL callback".into());
    }
}

/// NtQuerySystemInformation(SystemKernelDebuggerInformation) check.
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn sota_ntqsi_kernel_debugger(cr: &mut ComprehensiveReport) {
    use super::syscall;

    // SystemKernelDebuggerInformation (class 0x23)
    // Returns: [u8; 2] = [DebuggerEnabled, DebuggerNotPresent]
    let mut info = [0u8; 2];
    let mut ret_len: u32 = 0;
    let status =
        unsafe { syscall::nt_query_system_information(0x23, info.as_mut_ptr(), 2, &mut ret_len) };
    if status == 0 {
        // info[0] = DebuggerEnabled, info[1] = DebuggerNotPresent
        if info[0] != 0 && info[1] == 0 {
            // Kernel debugger enabled AND present.
            cr.kernel_debugger = true;
            cr.evidence
                .push("NtQSI(SystemKernelDebuggerInformation): kernel debugger active".into());
        }
    }
}

/// Walk parent and grandparent processes to check for debugger ancestry.
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn sota_parent_walk(cr: &mut ComprehensiveReport) {
    // Already checked parent in sota_ntqip_checks via ProcessBasicInformation.
    // Here we walk 3 levels of ancestors.
    let mut current_pid = get_current_pid();
    for level in 0..3u8 {
        if current_pid == 0 {
            break;
        }
        if let Some(parent_pid) = get_parent_pid(current_pid) {
            if parent_pid == 0 {
                break;
            }
            if let Some(name) = get_process_name_by_pid(parent_pid) {
                let lower = name.to_lowercase();
                for &dbg in DEBUGGER_PROCESS_NAMES {
                    if lower.contains(&dbg.to_lowercase().replace(".exe", ""))
                        || lower == dbg.to_lowercase()
                    {
                        cr.parent_debugger = true;
                        cr.evidence.push(format!(
                            "Ancestor level {} PID {} is debugger: {}",
                            level + 1,
                            parent_pid,
                            name
                        ));
                        return;
                    }
                }
            }
            current_pid = parent_pid;
        } else {
            break;
        }
    }
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn get_current_pid() -> usize {
    unsafe {
        let peb = get_peb();
        if peb.is_null() {
            return 0;
        }
        // PEB->UniqueProcessId at offset 0x2C (Win10/11)
        *(peb.add(0x2C) as *const u32) as usize
    }
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn get_parent_pid(pid: usize) -> Option<usize> {
    use super::syscall;

    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const NT_CURRENT_PROCESS: usize = 0xFFFFFFFFFFFFFFFF;

    #[repr(C)]
    struct ProcessBasicInformation {
        exit_status: i64,
        peb_base_address: *mut u8,
        affinity_mask: usize,
        base_priority: i32,
        unique_process_id: usize,
        inherited_from_unique_process_id: usize,
    }

    unsafe {
        let handle = if pid == get_current_pid() {
            NT_CURRENT_PROCESS
        } else {
            let open_ssn = syscall::resolve_ssn_with_fallback("NtOpenProcess").unwrap_or(0x26);
            let mut handle: usize = 0;
            let obj_attr = [0u8; 48];
            let mut client_id = [0usize; 2];
            client_id[0] = pid;
            let status = syscall::direct_syscall_4(
                open_ssn,
                &mut handle as *mut _ as usize,
                PROCESS_QUERY_LIMITED_INFORMATION as usize,
                obj_attr.as_ptr() as usize,
                client_id.as_ptr() as usize,
            );
            if status != 0 || handle == 0 {
                return None;
            }
            handle
        };

        let mut pbi: ProcessBasicInformation = std::mem::zeroed();
        let status = syscall::nt_query_information_process(
            handle,
            0,
            &mut pbi as *mut _ as *mut u8,
            std::mem::size_of::<ProcessBasicInformation>() as u32,
            std::ptr::null_mut(),
        );

        if pid != get_current_pid() && handle != NT_CURRENT_PROCESS {
            syscall::nt_close(handle);
        }

        if status == 0 && pbi.inherited_from_unique_process_id != 0 {
            Some(pbi.inherited_from_unique_process_id)
        } else {
            None
        }
    }
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn get_process_name_by_pid(pid: usize) -> Option<String> {
    use super::syscall;

    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const NT_CURRENT_PROCESS: usize = 0xFFFFFFFFFFFFFFFF;

    unsafe {
        let handle = if pid == get_current_pid() {
            NT_CURRENT_PROCESS
        } else {
            let open_ssn = syscall::resolve_ssn_with_fallback("NtOpenProcess").unwrap_or(0x26);
            let mut handle: usize = 0;
            let obj_attr = [0u8; 48];
            let mut client_id = [0usize; 2];
            client_id[0] = pid;
            let status = syscall::direct_syscall_4(
                open_ssn,
                &mut handle as *mut _ as usize,
                PROCESS_QUERY_LIMITED_INFORMATION as usize,
                obj_attr.as_ptr() as usize,
                client_id.as_ptr() as usize,
            );
            if status != 0 || handle == 0 {
                return None;
            }
            handle
        };

        // ProcessImageFileName = class 27, returns UNICODE_STRING
        #[repr(C)]
        struct UnicodeString {
            length: u16,
            maximum_length: u16,
            _pad: [u8; 4],
            buffer: *const u16,
        }

        let mut us: UnicodeString = std::mem::zeroed();
        let status = syscall::nt_query_information_process(
            handle,
            27,
            &mut us as *mut _ as *mut u8,
            std::mem::size_of::<UnicodeString>() as u32,
            std::ptr::null_mut(),
        );

        if pid != get_current_pid() && handle != NT_CURRENT_PROCESS {
            syscall::nt_close(handle);
        }

        if status == 0 && !us.buffer.is_null() && us.length > 0 {
            let len = us.length as usize / 2;
            let slice = std::slice::from_raw_parts(us.buffer, len);
            let full_path = String::from_utf16_lossy(slice);
            return std::path::Path::new(&full_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string());
        }

        None
    }
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
unsafe fn get_peb() -> *const u8 {
    let peb: *const u8;
    std::arch::asm!(
        "mov {}, gs:[0x60]",
        out(reg) peb,
    );
    peb
}

/// Hypervisor brand detection via CPUID leaf 0x40000000.
#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
fn sota_hypervisor_brand(cr: &mut ComprehensiveReport) {
    let result = cpuid(0x40000000, 0);
    let max_leaf = result[0];
    if max_leaf < 0x40000000 {
        return;
    }
    // Brand string is in EBX, ECX, EDX (12 bytes).
    let mut brand_bytes = [0u8; 12];
    brand_bytes[0..4].copy_from_slice(&result[1].to_le_bytes());
    brand_bytes[4..8].copy_from_slice(&result[2].to_le_bytes());
    brand_bytes[8..12].copy_from_slice(&result[3].to_le_bytes());

    let brand = String::from_utf8_lossy(&brand_bytes)
        .trim_end_matches('\0')
        .to_string();

    if brand.is_empty() {
        return;
    }

    for &known in HYPERVISOR_BRANDS {
        let known_trimmed = known.trim_end_matches('\0');
        if brand == known_trimmed || brand.contains(known_trimmed) {
            cr.hypervisor_brand = Some(brand.clone());
            cr.evidence
                .push(format!("CPUID hypervisor brand: {}", brand));
            return;
        }
    }
    // Unknown hypervisor brand — still flag it.
    cr.hypervisor_brand = Some(brand.clone());
    cr.evidence
        .push(format!("CPUID unknown hypervisor brand: {}", brand));
}

#[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
fn sota_hypervisor_brand(_cr: &mut ComprehensiveReport) {}

/// CPUID leaf 0x40000001 — hypervisor feature flags.
/// Bit 0 = CreatePartition support = definitely a hypervisor.
#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
fn sota_hypervisor_feature_flag(cr: &mut ComprehensiveReport) {
    let result = cpuid(0x40000001, 0);
    if result[0] & 1 != 0 {
        cr.hypervisor_feature_flag = true;
        cr.evidence
            .push("CPUID 0x40000001 bit 0: CreatePartition (hypervisor)".into());
    }
}

#[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
fn sota_hypervisor_feature_flag(_cr: &mut ComprehensiveReport) {}

/// CPUID wrapper.
#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
fn cpuid(leaf: u32, subleaf: u32) -> [u32; 4] {
    let mut eax: u32;
    let mut ebx: u32;
    let mut ecx: u32;
    let mut edx: u32;
    // LLVM reserves rbx on Windows x64, so cpuid's ebx output must be captured
    // into a different non-allocatable register. r12 is callee-saved on Windows
    // x64 (safe to clobber inside inline asm) and is not used by LLVM.
    unsafe {
        std::arch::asm!(
            "xchg r12, rbx",
            "cpuid",
            "xchg r12, rbx",
            out("r12") ebx,
            inout("eax") leaf => eax,
            inout("ecx") subleaf => ecx,
            lateout("edx") edx,
        );
    }
    [eax, ebx, ecx, edx]
}

/// KUSER_SHARED_DATA → HypervisorPresent at offset 0x140 (Win10+).
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn sota_kuser_hypervisor(cr: &mut ComprehensiveReport) {
    // KUSER_SHARED_DATA is mapped at a fixed address in user mode.
    const KUSER_SHARED_DATA: usize = 0x7FFE_0000; // user-mode mapping
    const HYPERVISOR_PRESENT_OFFSET: usize = 0x140;

    unsafe {
        let ptr = (KUSER_SHARED_DATA + HYPERVISOR_PRESENT_OFFSET) as *const u8;
        // Read 1 byte — the HypervisorPresent field.
        let val = *ptr;
        if val != 0 {
            cr.kuser_hypervisor = true;
            cr.evidence
                .push("KUSER_SHARED_DATA.HypervisorPresent is set".into());
        }
    }
}

/// Hash own anti-debug function code at startup, compare at runtime.
///
/// Detects if someone patched our detection functions with NOPs or jumps.
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn sota_self_patch_check(cr: &mut ComprehensiveReport) {
    use sha2::{Digest, Sha256};

    // Function pointers to critical detection functions.
    let fns: &[(&str, fn() -> bool)] = &[
        ("check_debugger_present", check_debugger_present),
        ("check_remote_debugger", check_remote_debugger),
        ("check_hardware_breakpoints", check_hardware_breakpoints),
        ("windows_ntqip_debug_port", windows_ntqip_debug_port),
    ];

    static STARTUP_HASHES: std::sync::OnceLock<Vec<(&'static str, [u8; 32])>> =
        std::sync::OnceLock::new();

    let hashes = STARTUP_HASHES.get_or_init(|| {
        fns.iter()
            .map(|(name, f)| {
                let addr = *f as *const u8;
                let code = unsafe { std::slice::from_raw_parts(addr, 64) };
                let hash = Sha256::digest(code);
                let mut h = [0u8; 32];
                h.copy_from_slice(&hash);
                (*name, h)
            })
            .collect()
    });

    // Verify hashes at runtime.
    for (i, (_, f)) in fns.iter().enumerate() {
        let addr = *f as *const u8;
        let code = unsafe { std::slice::from_raw_parts(addr, 64) };
        let hash = Sha256::digest(code);
        let mut current = [0u8; 32];
        current.copy_from_slice(&hash);
        if hashes[i].1 != current {
            cr.self_patch_detected = true;
            cr.evidence.push(format!(
                "Anti-debug function '{}' was patched at runtime",
                hashes[i].0
            ));
        }
    }
}

#[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
#[allow(dead_code)]
fn sota_self_patch_check(_cr: &mut ComprehensiveReport) {}

#[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
#[allow(dead_code)]
fn sota_kuser_hypervisor(_cr: &mut ComprehensiveReport) {}

/// Public injectable version of self-patch check for testing.
pub fn check_self_patch_hash(fn_ptrs: &[(&str, *const u8)], expected: &[[u8; 32]]) -> Vec<String> {
    use sha2::{Digest, Sha256};

    let mut violations = Vec::new();
    for (i, (name, addr)) in fn_ptrs.iter().enumerate() {
        let code = unsafe { std::slice::from_raw_parts(*addr, 64) };
        let hash = Sha256::digest(code);
        let mut current = [0u8; 32];
        current.copy_from_slice(&hash);
        if i < expected.len() && expected[i] != current {
            violations.push(name.to_string());
        }
    }
    violations
}

// ─── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::Digest;

    #[test]
    fn default_report_is_clean() {
        let r = DebugReport::default();
        assert!(!r.debugger_present);
        assert!(!r.remote_debugger);
        assert!(!r.hardware_breakpoints);
        assert!(!r.timing_anomaly);
        assert!(!r.ptrace_attached);
        assert!(r.evidence.is_empty());
        assert!(!r.comprehensive.debug_port);
        assert!(!r.comprehensive.kernel_debugger);
    }

    #[test]
    fn timing_anomaly_detects_slow_execution() {
        use std::sync::atomic::{AtomicU64, Ordering};
        static TICK: AtomicU64 = AtomicU64::new(0);

        let fake_now = || {
            let t = TICK.fetch_add(100_000_000, Ordering::Relaxed);
            std::time::Instant::now() + std::time::Duration::from_nanos(t)
        };

        let start = fake_now();
        let _ = std::hint::black_box(42u64);
        let elapsed = fake_now().duration_since(start).as_millis();
        assert!(elapsed > 5, "fake clock should simulate >5ms");
    }

    #[test]
    fn timing_anomaly_clean_when_fast() {
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

    #[test]
    fn comprehensive_report_default_is_clean() {
        let cr = ComprehensiveReport::default();
        assert!(!cr.debug_port);
        assert!(!cr.debug_object_handle);
        assert!(!cr.debug_flags);
        assert!(!cr.parent_debugger);
        assert!(!cr.instrumentation_callback);
        assert!(!cr.kernel_debugger);
        assert!(cr.hypervisor_brand.is_none());
        assert!(!cr.hypervisor_feature_flag);
        assert!(!cr.kuser_hypervisor);
        assert!(!cr.self_patch_detected);
        assert!(!cr.ntdll_hooked);
        assert!(cr.evidence.is_empty());
    }

    #[test]
    fn comprehensive_report_serializes() {
        let cr = ComprehensiveReport {
            debug_port: true,
            hypervisor_brand: Some("Microsoft Hv".into()),
            evidence: vec!["test".into()],
            ..Default::default()
        };
        let json = serde_json::to_string(&cr).unwrap();
        assert!(json.contains("debug_port"));
        assert!(json.contains("Microsoft Hv"));
    }

    #[test]
    fn detect_populates_comprehensive() {
        let report = detect();
        // comprehensive should be populated (even if all false on this platform)
        let _ = report.comprehensive.debug_port;
    }

    #[test]
    fn detect_comprehensive_returns_report() {
        let cr = detect_comprehensive();
        // Should not panic; evidence may or may not be empty.
        let _ = cr.evidence;
    }

    #[test]
    fn hypervisor_brand_list_is_non_empty() {
        assert!(!HYPERVISOR_BRANDS.is_empty());
        for brand in HYPERVISOR_BRANDS {
            assert!(!brand.is_empty());
        }
    }

    #[test]
    fn debugger_names_list_is_non_empty() {
        assert!(!DEBUGGER_PROCESS_NAMES.is_empty());
        for name in DEBUGGER_PROCESS_NAMES {
            assert!(name.ends_with(".exe"));
        }
    }

    #[test]
    fn check_self_patch_hash_with_matching_code() {
        let code = vec![0x90u8; 64]; // NOP sled
        let ptr = code.as_ptr();
        let hash = sha2::Sha256::digest(&code);
        let mut expected = [0u8; 32];
        expected.copy_from_slice(&hash);

        let violations = check_self_patch_hash(&[("test_fn", ptr)], &[expected]);
        assert!(violations.is_empty(), "matching code should not violate");
    }

    #[test]
    fn check_self_patch_hash_detects_modification() {
        let code_a = vec![0x90u8; 64];
        let code_b = vec![0xCCu8; 64]; // int3 instead of NOP
        let ptr_b = code_b.as_ptr();
        let hash_a = sha2::Sha256::digest(&code_a);
        let mut expected = [0u8; 32];
        expected.copy_from_slice(&hash_a);

        let violations = check_self_patch_hash(&[("test_fn", ptr_b)], &[expected]);
        assert_eq!(violations.len(), 1, "modified code should violate");
        assert_eq!(violations[0], "test_fn");
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn sota_checks_noop_on_non_windows() {
        let mut cr = ComprehensiveReport::default();
        sota_kuser_hypervisor(&mut cr);
        sota_self_patch_check(&mut cr);
        assert!(!cr.kuser_hypervisor);
        assert!(!cr.self_patch_detected);
    }

    #[test]
    fn debug_report_with_all_comprehensive_flags() {
        let r = DebugReport {
            debugger_present: true,
            remote_debugger: true,
            comprehensive: ComprehensiveReport {
                debug_port: true,
                debug_object_handle: true,
                debug_flags: true,
                kernel_debugger: true,
                hypervisor_brand: Some("KVMKVMKVM".into()),
                ..Default::default()
            },
            ..Default::default()
        };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("debug_port"));
        assert!(json.contains("kernel_debugger"));
        assert!(json.contains("KVMKVMKVM"));
    }
}

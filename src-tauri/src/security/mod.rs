pub mod amsi_check;
pub mod app_paths;
pub mod anti_debug;
pub mod anti_dump;
pub mod anti_forensic;
pub mod anti_hook;
pub mod anti_injection;
pub mod anti_screenshot;
pub mod anti_sniff;
pub mod anti_vm;
pub mod clock_guard;
pub mod dpapi_keystore;
pub mod firewall;
pub mod hostile_env;
pub mod install_cleanup;
pub mod ipc_auth;
pub mod mitigation_policy;
pub mod ntdll_integrity;
pub mod pde;
pub mod pde_seed;
pub mod pin_entry;
pub mod priv_strip;
pub mod raw_input;
pub mod registry_watch;
pub mod secrets_compat;
pub mod secure_delete;
pub mod secure_desktop;
pub mod secure_log;
pub mod self_integrity;
pub mod string_obfusc;
pub mod syscall;
pub mod telemetry_suppress;
pub mod usb_watch;

pub use amsi_check::*;
pub use anti_dump::*;
pub use clock_guard::*;
pub use firewall::*;
pub use hostile_env::{HostileEnvReport, HostileResponse, ResponseAction};
pub use mitigation_policy::*;
pub use ntdll_integrity::NtdllReport;
pub use priv_strip::*;
pub use registry_watch::*;
pub use secrets_compat::*;
pub use secure_delete::*;
pub use secure_log::*;
pub use self_integrity::*;
pub use syscall::{clear_ssn_cache, resolve_ssn_with_fallback, SyscallProvider};
pub use usb_watch::*;

pub fn install<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
    state: &crate::commands::auth::AppState,
) -> tauri::Builder<R> {
    let builder = ipc_auth::install(builder, state);
    builder
}

/// Run all security module startup checks. Called from the Tauri setup hook.
/// Each module's result is logged; failures are non-fatal (defense-in-depth).
pub fn run_security_init(
    app: &tauri::AppHandle<impl tauri::Runtime>,
    state: &crate::commands::auth::AppState,
) {
    // A panic in any single check must NOT abort dev startup. Wrap the whole
    // sequence in catch_unwind; a panicking check becomes a logged warning.
    // (Caveat: STATUS_ACCESS_VIOLATION from unsafe FFI is not a Rust panic and
    // will still terminate the process — those need a code-level fix.)
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        run_security_init_inner(app, state);
    }));
    if let Err(e) = res {
        log::error!("security: a startup check panicked; continuing: {e:?}");
    }
}

fn run_security_init_inner(
    app: &tauri::AppHandle<impl tauri::Runtime>,
    state: &crate::commands::auth::AppState,
) {
    // Anti-debug detection
    let debug_report = anti_debug::detect();
    if debug_report.debugger_present || debug_report.remote_debugger {
        log::warn!("security: debugger detected — {:?}", debug_report.evidence);
    }

    // Anti-VM detection
    let vm_report = anti_vm::detect();
    if vm_report.hypervisor_cpu || vm_report.vm_registry {
        log::warn!(
            "security: VM environment detected — {:?}",
            vm_report.evidence
        );
    }

    // Anti-sniff detection
    let sniff_report = anti_sniff::detect();
    if sniff_report.pcap_driver || sniff_report.analyzer_process {
        log::warn!(
            "security: network analyzer detected — {:?}",
            sniff_report.evidence
        );
    }

    // Hostile environment orchestration
    let hostile = hostile_env::check_all();
    log::info!("security: hostile env score = {}", hostile.score);

    let response_policy = state
        .settings
        .lock()
        .unwrap()
        .get("security.hostile_response")
        .and_then(|v| v.as_str())
        .map(|s| match s {
            "lock" => HostileResponse::Lock,
            "wipe" => HostileResponse::Wipe,
            _ => HostileResponse::Warn,
        })
        .unwrap_or(HostileResponse::Lock);

    let action = hostile_env::respond(&hostile, response_policy);
    match &action {
        ResponseAction::Log => {}
        ResponseAction::LockSession => {
            log::warn!("security: hostile environment — locking session");
        }
        ResponseAction::WipeData => {
            log::warn!("security: hostile environment — wipe requested (score >= 60)");
        }
    }

    // NTDLL integrity
    let ntdll_report = ntdll_integrity::check_ntdll_integrity();
    if !ntdll_report.text_hash_match || ntdll_report.hook_count > 0 {
        log::warn!(
            "security: ntdll integrity issue — hash_match={}, hooks={}",
            ntdll_report.text_hash_match,
            ntdll_report.hook_count
        );
    }

    // IAT hook detection
    match anti_hook::walk_iat() {
        Ok(iat) if iat.hooked_imports > 0 => {
            log::warn!(
                "security: {} IAT hooks detected — {:?}",
                iat.hooked_imports,
                iat.hooked_functions
            );
        }
        Ok(_) => {}
        Err(e) => log::warn!("security: IAT walk failed: {e}"),
    }

    // Process injection detection
    match anti_injection::check_peb_consistency() {
        Ok(false) => log::warn!("security: PEB consistency check failed — possible injection"),
        Ok(true) => {}
        Err(e) => log::warn!("security: PEB check failed: {e}"),
    }

    // Self-integrity check
    match self_integrity::self_integrity_check() {
        Ok(report) => {
            if !report.signed {
                log::warn!("security: executable is not Authenticode-signed");
            }
            log::info!("security: exe hash = {}", hex::encode(report.exe_hash));
        }
        Err(e) => log::warn!("security: self-integrity check failed: {e}"),
    }

    // Mitigation policies
    match mitigation_policy::apply_full_hardening() {
        Ok(report) => {
            if !report.all_critical_applied {
                log::warn!(
                    "security: not all critical mitigations applied — skipped {:?}",
                    report.skipped
                );
            }
        }
        Err(e) => log::warn!("security: mitigation policy failed: {e}"),
    }

    // Privilege stripping
    if let Err(e) = priv_strip::strip_se_debug_privilege() {
        log::warn!("security: failed to strip SeDebugPrivilege: {e}");
    }

    // Firewall
    match firewall::block_outbound_traffic() {
        Ok(report) => {
            if !report.outbound_blocked {
                log::warn!(
                    "security: outbound firewall rule not applied — {:?}",
                    report.errors
                );
            }
        }
        Err(e) => log::warn!("security: firewall setup failed: {e}"),
    }

    // Clock guard
    let mut clock = clock_guard::MonotonicClock::new();
    match clock.check_for_rollback() {
        Ok(v) if v.rollback_detected => {
            log::warn!("security: clock rollback detected — {}", v.explanation)
        }
        Ok(_) => {}
        Err(e) => log::warn!("security: clock guard failed: {e}"),
    }

    // AMSI check
    if amsi_check::is_amsi_bypassed() {
        log::warn!("security: AMSI appears to be bypassed");
    }

    // Registry watch (non-blocking, spawns thread)
    match registry_watch::watch_critical_keys(|| {
        log::warn!("security: critical registry key changed");
        hostile_env::increment_registry_change_count();
    }) {
        Ok(_) => log::info!("security: registry watch started"),
        Err(e) => log::warn!("security: registry watch failed: {e}"),
    }

    // Telemetry suppression (ETW/AppCompat/Prefetch/Timeline)
    telemetry_suppress::suppress_all();

    // Anti-forensic periodic scrub
    if let Err(e) = anti_forensic::install(app, state) {
        log::warn!("security: anti-forensic install failed: {e}");
    }

    // Anti-dump WER exclusion
    if let Err(e) = anti_dump::exclude_from_windows_error_reporting() {
        log::warn!("security: WER exclusion failed: {e}");
    }

    // USB watch (requires window handle, deferred to when window is available)
    log::info!("security: USB watch deferred (requires window handle)");

    // Secure desktop (created on-demand for PIN entry, not at startup)
    log::info!("security: secure desktop available on-demand");

    log::info!("security: all startup checks complete");
}

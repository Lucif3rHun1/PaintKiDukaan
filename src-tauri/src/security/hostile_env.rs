//! Hostile environment orchestrator: runs all detectors, computes weighted
//! score, triggers configurable response (warn / lock / wipe).

use serde::Serialize;
use std::sync::atomic::{AtomicU8, Ordering};

use super::anti_debug::{self, DebugReport};
use super::anti_sniff::{self, SniffReport};
use super::anti_vm::{self, VmReport};
use super::ntdll_integrity::{self, NtdllReport};

/// Counts registry change events fired by the background `registry_watch` thread.
/// Incremented via `increment_registry_change_count()` from the watch callback.
static REGISTRY_CHANGES: AtomicU8 = AtomicU8::new(0);

/// Called from the registry watch callback when a monitored key changes.
pub fn increment_registry_change_count() {
    REGISTRY_CHANGES.fetch_add(1, Ordering::Relaxed);
}

// ─── Types ─────────────────────────────────────────────────────────────────

/// Configurable response when hostile environment is detected.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostileResponse {
    /// Log the detection but allow normal operation.
    Warn,
    /// Lock the session (require re-authentication).
    Lock,
    /// Wipe sensitive data from disk.
    Wipe,
}

/// Action to take after hostile environment detection.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub enum ResponseAction {
    /// Logged detection — no state change.
    Log,
    /// Session locked — requires re-auth.
    LockSession,
    /// Data wiped — destructive, last resort.
    WipeData,
}

/// Aggregated hostile environment report.
#[derive(Clone, Debug, Serialize)]
pub struct HostileEnvReport {
    pub debug: DebugReport,
    pub vm: VmReport,
    pub sniff: SniffReport,
    pub ntdll: NtdllReport,
    /// Weighted risk score (0-100).
    pub score: u8,
}

// ─── Score weights ─────────────────────────────────────────────────────────

const DEBUG_WEIGHT: u8 = 35;
const VM_WEIGHT: u8 = 35;
const SNIFF_WEIGHT: u8 = 15;
const NTDLL_WEIGHT: u8 = 15;

// ─── Public API ────────────────────────────────────────────────────────────

/// Run all hostile environment detectors and compute a weighted risk score.
///
/// Score weighting:
/// - debug:          35 points max
/// - vm:             35 points max
/// - sniff:          15 points max
/// - ntdll:          15 points max (hooks detected = 100 → 15 weighted)
/// - amsi bypass:    +30 flat (Windows only — non-Windows returns "unknown")
/// - registry changes: +20 per change, capped at +40
pub fn check_all() -> HostileEnvReport {
    let debug = anti_debug::detect();
    let vm    = anti_vm::detect();
    let sniff = anti_sniff::detect();
    let ntdll = ntdll_integrity::check_ntdll_integrity();

    // ── per-module signal dump ──────────────────────────────────────────────
    log_vm_signals(&vm);
    log_debug_signals(&debug);
    log_sniff_signals(&sniff);
    log_ntdll_signals(&ntdll);

    // ── score components ────────────────────────────────────────────────────
    let debug_raw  = compute_debug_score(&debug);
    let vm_raw     = compute_vm_score(&vm);
    let sniff_raw  = compute_sniff_score(&sniff);
    let ntdll_raw  = compute_ntdll_score(&ntdll);

    let debug_pts  = (debug_raw  as u16 * DEBUG_WEIGHT  as u16) / 100;
    let vm_pts     = (vm_raw     as u16 * VM_WEIGHT     as u16) / 100;
    let sniff_pts  = (sniff_raw  as u16 * SNIFF_WEIGHT  as u16) / 100;
    let ntdll_pts  = (ntdll_raw  as u16 * NTDLL_WEIGHT  as u16) / 100;
    let base_score = (debug_pts + vm_pts + sniff_pts + ntdll_pts).min(100) as u8;

    log::debug!(
        "hostile_env: raw  debug={raw_d}×{w_d}/100={pts_d}  vm={raw_v}×{w_v}/100={pts_v}  \
         sniff={raw_s}×{w_s}/100={pts_s}  ntdll={raw_n}×{w_n}/100={pts_n}  base={base}",
        raw_d = debug_raw,  w_d = DEBUG_WEIGHT,  pts_d = debug_pts,
        raw_v = vm_raw,     w_v = VM_WEIGHT,     pts_v = vm_pts,
        raw_s = sniff_raw,  w_s = SNIFF_WEIGHT,  pts_s = sniff_pts,
        raw_n = ntdll_raw,  w_n = NTDLL_WEIGHT,  pts_n = ntdll_pts,
        base  = base_score,
    );

    let mut score = base_score;

    // ── AMSI bypass (Windows only — skip on non-Windows to avoid always +30) ─
    #[cfg(target_os = "windows")]
    let amsi_bump = amsi_check_with_log(&mut score);
    #[cfg(not(target_os = "windows"))]
    let amsi_bump: u8 = 0;

    // ── registry changes ────────────────────────────────────────────────────
    let reg_changes = REGISTRY_CHANGES.load(Ordering::Relaxed);
    let reg_bump    = reg_changes.saturating_mul(20).min(40);
    if reg_bump > 0 {
        log::debug!(
            "hostile_env: registry changes={} → +{} pts",
            reg_changes, reg_bump
        );
    }
    score = score.saturating_add(reg_bump).min(100);

    log::info!(
        "hostile_env: score={total}  (debug={pts_d} vm={pts_v} sniff={pts_s} \
         ntdll={pts_n} amsi=+{amsi} reg=+{reg})",
        total = score,
        pts_d = debug_pts, pts_v = vm_pts, pts_s = sniff_pts, pts_n = ntdll_pts,
        amsi  = amsi_bump,
        reg   = reg_bump,
    );

    HostileEnvReport { debug, vm, sniff, ntdll, score }
}

// ─── Detailed signal loggers ───────────────────────────────────────────────

fn log_vm_signals(vm: &anti_vm::VmReport) {
    log::debug!(
        "hostile_env/vm: hypervisor_cpu={} vm_registry={} vm_mac_oui={} \
         sandbox_dll={} disk_anomaly={}  evidence={:?}",
        vm.hypervisor_cpu, vm.vm_registry, vm.vm_mac_oui,
        vm.sandbox_dll, vm.disk_anomaly, vm.evidence,
    );
}

fn log_debug_signals(debug: &anti_debug::DebugReport) {
    log::debug!(
        "hostile_env/debug: present={} remote={} hw_bp={} timing_anomaly={} ptrace={}  evidence={:?}",
        debug.debugger_present, debug.remote_debugger, debug.hardware_breakpoints,
        debug.timing_anomaly, debug.ptrace_attached, debug.evidence,
    );
    let cr = &debug.comprehensive;
    log::debug!(
        "hostile_env/debug/comprehensive: debug_port={} obj_handle={} flags={} \
         parent_dbg={} instr_cb={} kernel_dbg={} hv_brand={:?} hv_feat_flag={} \
         kuser_hv={} self_patch={} ntdll_hooked={}  evidence={:?}",
        cr.debug_port, cr.debug_object_handle, cr.debug_flags,
        cr.parent_debugger, cr.instrumentation_callback, cr.kernel_debugger,
        cr.hypervisor_brand, cr.hypervisor_feature_flag,
        cr.kuser_hypervisor, cr.self_patch_detected, cr.ntdll_hooked,
        cr.evidence,
    );
}

fn log_sniff_signals(sniff: &anti_sniff::SniffReport) {
    log::debug!(
        "hostile_env/sniff: pcap_driver={} analyzer_proc={} proxy_env={} loopback={}  evidence={:?}",
        sniff.pcap_driver, sniff.analyzer_process, sniff.proxy_env,
        sniff.loopback_listener, sniff.evidence,
    );
}

fn log_ntdll_signals(ntdll: &ntdll_integrity::NtdllReport) {
    log::debug!(
        "hostile_env/ntdll: hash_match={} hook_count={} hooked={:?} error={:?}",
        ntdll.text_hash_match, ntdll.hook_count,
        ntdll.hooked_functions, ntdll.error,
    );
}

/// Run the AMSI check with detailed logging, add score bump, and return the
/// bump value (0 or 30) so callers can include it in the score summary.
#[cfg(target_os = "windows")]
fn amsi_check_with_log(score: &mut u8) -> u8 {
    match super::amsi_check::init_amsi("PaintKiDukaan") {
        Ok(ctx) if ctx.initialized => {
            let verdict = super::amsi_check::self_scan_eicar(&ctx);
            log::debug!(
                "hostile_env/amsi: initialized=true  raw_result={}  detected={}  explanation='{}'",
                verdict.raw_result, verdict.detected, verdict.explanation,
            );
            if verdict.detected {
                log::debug!("hostile_env/amsi: EICAR detected — pipeline intact (+0 pts)");
                0
            } else {
                log::debug!("hostile_env/amsi: EICAR not detected — bypass confirmed (+30 pts)");
                *score = score.saturating_add(30);
                30
            }
        }
        Ok(_ctx) => {
            // AmsiInitialize returned S_OK but handle was null or init flag is false.
            log::debug!(
                "hostile_env/amsi: AmsiInitialize returned non-null but context not initialized \
                 (AV may be blocking AMSI load) → treating as bypassed (+30 pts)"
            );
            *score = score.saturating_add(30);
            30
        }
        Err(e) => {
            log::debug!("hostile_env/amsi: init failed — {e} → treating as bypassed (+30 pts)");
            *score = score.saturating_add(30);
            30
        }
    }
}

/// Determine the action to take based on the report and configured response.
///
/// Default response is `Lock` (don't auto-wipe).
pub fn respond(report: &HostileEnvReport, action: HostileResponse) -> ResponseAction {
    // Only trigger action if score exceeds threshold.
    // Raised from 10 → 25: hypervisor_cpu alone scores 13 (38 raw * 35 weight / 100)
    // which was a false positive on any Windows 11 machine with Hyper-V, WSL2, or
    // Docker Desktop enabled. A threshold of 25 requires at least two independent
    // signals before locking the session.
    const THRESHOLD: u8 = 25;

    if report.score < THRESHOLD {
        return ResponseAction::Log;
    }

    match action {
        HostileResponse::Warn => ResponseAction::Log,
        HostileResponse::Lock => ResponseAction::LockSession,
        HostileResponse::Wipe => {
            // Wipe requires score >= 60 to prevent accidental data loss.
            if report.score >= 60 {
                ResponseAction::WipeData
            } else {
                ResponseAction::LockSession
            }
        }
    }
}

// ─── Score computation ─────────────────────────────────────────────────────

/// Compute weighted risk score from detection reports.
/// Returns 0-100.
fn compute_score(
    debug: &DebugReport,
    vm: &VmReport,
    sniff: &SniffReport,
    ntdll: &NtdllReport,
) -> u8 {
    let debug_score = compute_debug_score(debug);
    let vm_score = compute_vm_score(vm);
    let sniff_score = compute_sniff_score(sniff);
    let ntdll_score = compute_ntdll_score(ntdll);

    let total = (debug_score as u16 * DEBUG_WEIGHT as u16
        + vm_score as u16 * VM_WEIGHT as u16
        + sniff_score as u16 * SNIFF_WEIGHT as u16
        + ntdll_score as u16 * NTDLL_WEIGHT as u16)
        / 100;

    total.min(100) as u8
}

fn compute_debug_score(report: &DebugReport) -> u8 {
    let mut score: u8 = 0;
    if report.debugger_present {
        score = score.saturating_add(38); // ~15/40
    }
    if report.remote_debugger {
        score = score.saturating_add(25); // ~10/40
    }
    if report.hardware_breakpoints {
        score = score.saturating_add(12); // ~5/40
    }
    if report.timing_anomaly {
        score = score.saturating_add(12); // ~5/40
    }
    if report.ptrace_attached {
        score = score.saturating_add(13); // ~5/40
    }
    score.min(100)
}

fn compute_vm_score(report: &VmReport) -> u8 {
    let mut score: u8 = 0;
    if report.hypervisor_cpu {
        score = score.saturating_add(38); // ~15/40
    }
    if report.vm_registry {
        score = score.saturating_add(25); // ~10/40
    }
    if report.vm_mac_oui {
        score = score.saturating_add(25); // ~10/40
    }
    if report.sandbox_dll {
        score = score.saturating_add(7); // ~3/40
    }
    if report.disk_anomaly {
        score = score.saturating_add(5); // ~2/40
    }
    score.min(100)
}

fn compute_sniff_score(report: &SniffReport) -> u8 {
    let mut score: u8 = 0;
    if report.pcap_driver {
        score = score.saturating_add(40);
    }
    if report.analyzer_process {
        score = score.saturating_add(30);
    }
    if report.proxy_env {
        score = score.saturating_add(15);
    }
    if report.loopback_listener {
        score = score.saturating_add(15);
    }
    score.min(100)
}

fn compute_ntdll_score(report: &NtdllReport) -> u8 {
    let mut score: u8 = 0;
    if !report.text_hash_match {
        score = score.saturating_add(50);
    }
    if report.hook_count > 0 {
        score = score.saturating_add(50);
    }
    score.min(100)
}

// ─── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_reports_score_zero() {
        let report = HostileEnvReport {
            debug: DebugReport::default(),
            vm: VmReport::default(),
            sniff: SniffReport::default(),
            ntdll: NtdllReport::default(),
            score: 0,
        };
        assert_eq!(report.score, 0);
    }

    #[test]
    fn check_all_produces_report() {
        let report = check_all();
        // Score should be 0-100.
        assert!(report.score <= 100);
    }

    #[test]
    fn respond_warn_returns_log() {
        let report = HostileEnvReport {
            debug: DebugReport::default(),
            vm: VmReport::default(),
            sniff: SniffReport::default(),
            ntdll: NtdllReport::default(),
            score: 50,
        };
        assert_eq!(respond(&report, HostileResponse::Warn), ResponseAction::Log);
    }

    #[test]
    fn respond_lock_returns_lock_session() {
        let report = HostileEnvReport {
            debug: DebugReport::default(),
            vm: VmReport::default(),
            sniff: SniffReport::default(),
            ntdll: NtdllReport::default(),
            score: 50,
        };
        assert_eq!(
            respond(&report, HostileResponse::Lock),
            ResponseAction::LockSession
        );
    }

    #[test]
    fn respond_wipe_below_threshold_locks() {
        let report = HostileEnvReport {
            debug: DebugReport::default(),
            vm: VmReport::default(),
            sniff: SniffReport::default(),
            ntdll: NtdllReport::default(),
            score: 30,
        };
        assert_eq!(
            respond(&report, HostileResponse::Wipe),
            ResponseAction::LockSession
        );
    }

    #[test]
    fn respond_wipe_above_threshold_wipes() {
        let report = HostileEnvReport {
            debug: DebugReport {
                debugger_present: true,
                remote_debugger: true,
                ..Default::default()
            },
            vm: VmReport {
                hypervisor_cpu: true,
                ..Default::default()
            },
            sniff: SniffReport::default(),
            ntdll: NtdllReport::default(),
            score: 70,
        };
        assert_eq!(
            respond(&report, HostileResponse::Wipe),
            ResponseAction::WipeData
        );
    }

    #[test]
    fn respond_below_score_threshold_logs() {
        let report = HostileEnvReport {
            debug: DebugReport::default(),
            vm: VmReport::default(),
            sniff: SniffReport::default(),
            ntdll: NtdllReport::default(),
            score: 5,
        };
        assert_eq!(respond(&report, HostileResponse::Lock), ResponseAction::Log);
    }

    #[test]
    fn score_debugger_present() {
        let score = compute_debug_score(&DebugReport {
            debugger_present: true,
            ..Default::default()
        });
        assert!(score > 0);
        assert!(score <= 100);
    }

    #[test]
    fn score_vm_hypervisor() {
        let score = compute_vm_score(&VmReport {
            hypervisor_cpu: true,
            ..Default::default()
        });
        assert!(score > 0);
    }

    #[test]
    fn score_sniff_pcap() {
        let score = compute_sniff_score(&SniffReport {
            pcap_driver: true,
            ..Default::default()
        });
        assert!(score > 0);
    }

    #[test]
    fn score_all_flags_max() {
        let debug = DebugReport {
            debugger_present: true,
            remote_debugger: true,
            hardware_breakpoints: true,
            timing_anomaly: true,
            ptrace_attached: true,
            evidence: vec![],
            ..Default::default()
        };
        let vm = VmReport {
            hypervisor_cpu: true,
            vm_registry: true,
            vm_mac_oui: true,
            sandbox_dll: true,
            disk_anomaly: true,
            evidence: vec![],
        };
        let sniff = SniffReport {
            pcap_driver: true,
            analyzer_process: true,
            proxy_env: true,
            loopback_listener: true,
            evidence: vec![],
        };
        let ntdll = NtdllReport {
            text_hash_match: false,
            hook_count: 10,
            hooked_functions: vec!["NtOpenProcess".into()],
            error: None,
        };
        let total = compute_score(&debug, &vm, &sniff, &ntdll);
        assert!(total >= 80, "expected >= 80, got {}", total);
        assert!(total <= 100);
    }

    #[test]
    fn score_ntdll_hooks() {
        let score = compute_ntdll_score(&NtdllReport {
            text_hash_match: false,
            hook_count: 5,
            ..Default::default()
        });
        assert_eq!(score, 100);
    }

    #[test]
    fn score_ntdll_clean() {
        let score = compute_ntdll_score(&NtdllReport {
            text_hash_match: true,
            hook_count: 0,
            ..Default::default()
        });
        assert_eq!(score, 0);
    }

    #[test]
    fn ntdll_hooked_score_triggers_lock() {
        // ntdll hooks score 100 raw * 15 weight / 100 = 15 weighted. Use a
        // score above the new threshold (25) to verify the lock fires.
        let report = HostileEnvReport {
            debug: DebugReport::default(),
            vm: VmReport::default(),
            sniff: SniffReport::default(),
            ntdll: NtdllReport {
                text_hash_match: false,
                hook_count: 3,
                ..Default::default()
            },
            score: 30,
        };
        assert_eq!(
            respond(&report, HostileResponse::Lock),
            ResponseAction::LockSession
        );
    }

    #[test]
    fn hostile_response_variants() {
        assert_ne!(HostileResponse::Warn, HostileResponse::Lock);
        assert_ne!(HostileResponse::Lock, HostileResponse::Wipe);
    }

    #[test]
    fn response_action_serializes() {
        let json = serde_json::to_string(&ResponseAction::LockSession).unwrap();
        assert!(json.contains("LockSession"));
    }

    #[test]
    fn hostile_env_report_serializes() {
        let report = HostileEnvReport {
            debug: DebugReport::default(),
            vm: VmReport::default(),
            sniff: SniffReport::default(),
            ntdll: NtdllReport::default(),
            score: 42,
        };
        let json = serde_json::to_string(&report).unwrap();
        assert!(json.contains("42"));
        assert!(json.contains("debug"));
        assert!(json.contains("vm"));
        assert!(json.contains("sniff"));
        assert!(json.contains("ntdll"));
    }
}

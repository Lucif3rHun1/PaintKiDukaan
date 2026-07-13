//! Hostile environment orchestrator: runs all detectors, computes weighted
//! score, triggers configurable response (warn / lock / wipe).

use serde::Serialize;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

use super::anti_debug::{self, DebugReport};
use super::anti_sniff::{self, SniffReport};
use super::anti_vm::{self, VmReport};
use super::ntdll_integrity::{self, NtdllReport};

static REGISTRY_CHANGES: AtomicU8 = AtomicU8::new(0);

static PROCESS_START: OnceLock<Instant> = OnceLock::new();

pub fn increment_registry_change_count() {
    REGISTRY_CHANGES.fetch_add(1, Ordering::Relaxed);
}

// ponytail: Windows Update hot-patches ntdll without updating the on-disk copy,
// causing hash mismatch until reboot. 30s grace prevents false locks on startup.
fn startup_grace_active() -> bool {
    PROCESS_START.get_or_init(Instant::now).elapsed().as_secs() < 30
}

// ─── Types ─────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostileResponse {
    Warn,
    Lock,
    Wipe,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub enum ResponseAction {
    Log,
    LockSession,
    WipeData,
}

#[derive(Clone, Debug, Serialize)]
pub struct HostileEnvReport {
    pub debug: DebugReport,
    pub vm: VmReport,
    pub sniff: SniffReport,
    pub ntdll: NtdllReport,
    pub score: u8,
}

// ─── Score weights ─────────────────────────────────────────────────────────

const DEBUG_WEIGHT: u8 = 35;
const VM_WEIGHT: u8 = 35;
const SNIFF_WEIGHT: u8 = 15;
const NTDLL_WEIGHT: u8 = 15;

// ─── Public API ────────────────────────────────────────────────────────────

/// Run all hostile environment detectors and compute a weighted risk score.
pub fn check_all() -> HostileEnvReport {
    let debug = anti_debug::detect();
    let vm    = anti_vm::detect();
    let sniff = anti_sniff::detect();
    let ntdll = ntdll_integrity::check_ntdll_integrity();

    log_vm_signals(&vm);
    log_debug_signals(&debug);
    log_sniff_signals(&sniff);
    log_ntdll_signals(&ntdll);

    let debug_raw  = compute_debug_score(&debug);
    let vm_raw     = compute_vm_score(&vm);
    let sniff_raw  = compute_sniff_score(&sniff);
    let ntdll_raw  = compute_ntdll_score(&ntdll);

    let debug_pts  = (debug_raw  as u16 * DEBUG_WEIGHT  as u16) / 100;
    let vm_pts     = (vm_raw     as u16 * VM_WEIGHT     as u16) / 100;
    let sniff_pts  = (sniff_raw  as u16 * SNIFF_WEIGHT  as u16) / 100;
    let mut ntdll_pts = (ntdll_raw  as u16 * NTDLL_WEIGHT  as u16) / 100;

    // ponytail: skip ntdll during 30s startup grace. Windows Update hot-patches
    // ntdll in memory without updating on-disk copy → hash mismatch until reboot.
    if startup_grace_active() {
        log::debug!("hostile_env: ntdll scoring skipped (within 30s startup grace period)");
        ntdll_pts = 0;
    }

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

    #[allow(unused_mut)]
    let mut score = base_score;

    #[cfg(target_os = "windows")]
    let amsi_bump = amsi_check_with_log(&mut score);
    #[cfg(not(target_os = "windows"))]
    let amsi_bump: u8 = 0;

    log::info!(
        "hostile_env: score={total}  (debug={pts_d} vm={pts_v} sniff={pts_s} \
         ntdll={pts_n} amsi=+{amsi})",
        total = score,
        pts_d = debug_pts, pts_v = vm_pts, pts_s = sniff_pts, pts_n = ntdll_pts,
        amsi  = amsi_bump,
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

// ponytail: AMSI init fails on fresh Windows installs without AV configured.
// Require at least one other signal (score > 0) before adding the +30 penalty.
#[cfg(target_os = "windows")]
fn amsi_check_with_log(score: &mut u8) -> u8 {
    let (initialized, detected, init_failed) =
        match super::amsi_check::init_amsi("PaintKiDukaan") {
            Ok(ctx) if ctx.initialized => {
                let verdict = super::amsi_check::self_scan_eicar(&ctx);
                log::debug!(
                    "hostile_env/amsi: initialized=true  raw_result={}  detected={}  explanation='{}'",
                    verdict.raw_result, verdict.detected, verdict.explanation,
                );
                (true, verdict.detected, false)
            }
            Ok(ctx) => {
                log::info!(
                    "hostile_env/amsi: no_provider reason='AmsiInitialize returned non-null but no AV provider registered' app='{}' initialized=false (+0 pts)",
                    ctx.app_name,
                );
                (false, false, false)
            }
            Err(e) => {
                log::debug!("hostile_env/amsi: init failed — {e} → treating as bypassed (+30 pts)");
                (false, false, true)
            }
        };

    let bump = amsi_bump_for(initialized, detected, init_failed);

    if bump == 0 {
        return 0;
    }
    if *score == 0 {
        log::debug!(
            "hostile_env/amsi: bypass signal ignored — no corroborating signals (score=0)"
        );
        return 0;
    }

    *score = score.saturating_add(bump);
    bump
}

#[cfg(any(target_os = "windows", test))]
fn amsi_bump_for(initialized: bool, detected: bool, init_failed: bool) -> u8 {
    if init_failed {
        return 30;
    }
    if !initialized {
        return 0;
    }
    if !detected {
        return 30;
    }
    0
}

pub fn respond(report: &HostileEnvReport, action: HostileResponse) -> ResponseAction {
    const THRESHOLD: u8 = 25;

    if report.score < THRESHOLD {
        return ResponseAction::Log;
    }

    match action {
        HostileResponse::Warn => ResponseAction::Log,
        HostileResponse::Lock => ResponseAction::LockSession,
        HostileResponse::Wipe => {
            if report.score >= 60 {
                ResponseAction::WipeData
            } else {
                ResponseAction::LockSession
            }
        }
    }
}

// ─── Score computation ─────────────────────────────────────────────────────

#[cfg(test)]
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
        score = score.saturating_add(38);
    }
    if report.remote_debugger {
        score = score.saturating_add(25);
    }
    if report.hardware_breakpoints {
        score = score.saturating_add(12);
    }
    if report.timing_anomaly {
        score = score.saturating_add(12);
    }
    if report.ptrace_attached {
        score = score.saturating_add(13);
    }
    score.min(100)
}

fn compute_vm_score(report: &VmReport) -> u8 {
    let mut score: u8 = 0;
    if report.hypervisor_cpu {
        score = score.saturating_add(38);
    }
    if report.vm_registry {
        score = score.saturating_add(25);
    }
    if report.vm_mac_oui {
        score = score.saturating_add(25);
    }
    if report.sandbox_dll {
        score = score.saturating_add(7);
    }
    if report.disk_anomaly {
        score = score.saturating_add(5);
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
    fn score_sniff_loopback_listener_is_zero() {
        let score = compute_sniff_score(&SniffReport {
            loopback_listener: true,
            ..Default::default()
        });
        assert_eq!(score, 0, "loopback_listener signal must not contribute to sniff score");
    }

    #[test]
    fn score_sniff_other_signals_still_score() {
        let pcap = compute_sniff_score(&SniffReport {
            pcap_driver: true,
            ..Default::default()
        });
        let analyzer = compute_sniff_score(&SniffReport {
            analyzer_process: true,
            ..Default::default()
        });
        let proxy = compute_sniff_score(&SniffReport {
            proxy_env: true,
            ..Default::default()
        });
        assert!(pcap > 0);
        assert!(analyzer > 0);
        assert!(proxy > 0);
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

    #[test]
    fn amsi_no_provider_zero() {
        assert_eq!(amsi_bump_for(false, false, false), 0);
    }

    #[test]
    fn amsi_init_failed_thirty() {
        assert_eq!(amsi_bump_for(false, false, true), 30);
    }

    #[test]
    fn amsi_bypass_confirmed_thirty() {
        assert_eq!(amsi_bump_for(true, false, false), 30);
    }

    #[test]
    fn amsi_eicar_detected_zero() {
        assert_eq!(amsi_bump_for(true, true, false), 0);
    }

    #[test]
    fn clean_win11_minimal_state_under_lock() {
        let debug = DebugReport::default();
        let vm = VmReport { hypervisor_cpu: true, ..Default::default() };
        let sniff = SniffReport::default();
        let ntdll = NtdllReport { text_hash_match: true, ..Default::default() };
        let total = compute_score(&debug, &vm, &sniff, &ntdll);
        assert!(total < 25, "clean Win11 minimal must score < 25, got {}", total);
    }

    #[test]
    fn clean_win11_with_loopback_listener_still_under_lock() {
        let debug = DebugReport::default();
        let vm = VmReport { hypervisor_cpu: true, ..Default::default() };
        let sniff = SniffReport { loopback_listener: true, ..Default::default() };
        let ntdll = NtdllReport { text_hash_match: true, ..Default::default() };
        let total = compute_score(&debug, &vm, &sniff, &ntdll);
        assert!(total < 25, "loopback_listener FP must not push past lock, got {}", total);
    }
}

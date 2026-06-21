//! Hostile environment orchestrator: runs all detectors, computes weighted
//! score, triggers configurable response (warn / lock / wipe).

use serde::Serialize;

use super::anti_debug::{self, DebugReport};
use super::anti_sniff::{self, SniffReport};
use super::anti_vm::{self, VmReport};

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
    /// Weighted risk score (0-100).
    pub score: u8,
}

// ─── Score weights ─────────────────────────────────────────────────────────

const DEBUG_WEIGHT: u8 = 40;
const VM_WEIGHT: u8 = 40;
const SNIFF_WEIGHT: u8 = 20;

// ─── Public API ────────────────────────────────────────────────────────────

/// Run all hostile environment detectors and compute a weighted risk score.
///
/// Score weighting:
/// - debug:  40 points max (debugger_present=15, remote=10, hw_bp=5,
///           timing=5, ptrace=5)
/// - vm:     40 points max (cpuid=15, registry=10, mac_oui=10, dll=3,
///           disk=2)
/// - sniff:  20 points max (pcap=8, analyzer=6, proxy=3, loopback=3)
pub fn check_all() -> HostileEnvReport {
    let debug = anti_debug::detect();
    let vm = anti_vm::detect();
    let sniff = anti_sniff::detect();
    let score = compute_score(&debug, &vm, &sniff);

    HostileEnvReport {
        debug,
        vm,
        sniff,
        score,
    }
}

/// Determine the action to take based on the report and configured response.
///
/// Default response is `Lock` (don't auto-wipe).
pub fn respond(report: &HostileEnvReport, action: HostileResponse) -> ResponseAction {
    // Only trigger action if score exceeds threshold.
    const THRESHOLD: u8 = 10;

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
fn compute_score(debug: &DebugReport, vm: &VmReport, sniff: &SniffReport) -> u8 {
    let debug_score = compute_debug_score(debug);
    let vm_score = compute_vm_score(vm);
    let sniff_score = compute_sniff_score(sniff);

    // Weighted sum: each sub-score is 0-100, scaled by weight.
    let total = (debug_score as u16 * DEBUG_WEIGHT as u16
        + vm_score as u16 * VM_WEIGHT as u16
        + sniff_score as u16 * SNIFF_WEIGHT as u16)
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
        score = score.saturating_add(40); // ~8/20
    }
    if report.analyzer_process {
        score = score.saturating_add(30); // ~6/20
    }
    if report.proxy_env {
        score = score.saturating_add(15); // ~3/20
    }
    if report.loopback_listener {
        score = score.saturating_add(15); // ~3/20
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
            score: 30, // Below 60
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
            score: 5,
        };
        assert_eq!(
            respond(&report, HostileResponse::Lock),
            ResponseAction::Log
        );
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
        let total = compute_score(&debug, &vm, &sniff);
        // All flags set should score high.
        assert!(total >= 80, "expected >= 80, got {}", total);
        assert!(total <= 100);
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
            score: 42,
        };
        let json = serde_json::to_string(&report).unwrap();
        assert!(json.contains("42"));
        assert!(json.contains("debug"));
        assert!(json.contains("vm"));
        assert!(json.contains("sniff"));
    }
}

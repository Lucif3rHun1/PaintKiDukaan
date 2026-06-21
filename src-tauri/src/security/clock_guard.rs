//! Time rollback detection via monotonic vs wall-clock drift analysis.
//!
//! Uses `QueryPerformanceCounter` (Windows) or `std::time::Instant` (other OS)
//! as the monotonic source, and `GetSystemTimeAsFileTime` (Windows) or
//! `SystemTime` (other OS) for wall-clock time. If the wall clock jumps
//! backward beyond a configurable tolerance, a rollback is flagged.

use serde::Serialize;

use crate::error::AppError;

// ─── Constants ──────────────────────────────────────────────────────────────

/// Default tolerance in milliseconds. A wall-clock drift of less than this
/// is considered normal NTP adjustment.
const DEFAULT_TOLERANCE_MS: i64 = 5000;

// ─── Types ──────────────────────────────────────────────────────────────────

/// Verdict from a time rollback check.
#[derive(Clone, Debug, Serialize)]
pub struct TimeVerdict {
    /// `true` if a clock rollback was detected.
    pub rollback_detected: bool,
    /// Wall-clock drift from expected (ms). Negative = clock went backward.
    pub wall_drift_ms: i64,
    /// Monotonic clock drift (ms). Should be ~0 on a healthy system.
    pub monotonic_drift_ms: i64,
    /// Human-readable explanation.
    pub explanation: String,
}

/// Monotonic clock baseline for rollback detection.
pub struct MonotonicClock {
    /// Initial monotonic counter value (QPC ticks or Instant).
    #[cfg(target_os = "windows")]
    baseline_qpc: i64,
    /// QPC frequency (ticks per second).
    #[cfg(target_os = "windows")]
    qpc_frequency: i64,
    /// Initial wall-clock time in 100ns intervals since 1601-01-01.
    #[cfg(target_os = "windows")]
    baseline_wall: i64,
    /// Last checked wall-clock time.
    #[cfg(target_os = "windows")]
    last_check_wall: i64,

    /// Non-Windows: baseline monotonic instant.
    #[cfg(not(target_os = "windows"))]
    baseline_instant: std::time::Instant,
    /// Non-Windows: baseline system time.
    #[cfg(not(target_os = "windows"))]
    baseline_wall: std::time::SystemTime,
    /// Non-Windows: last checked system time.
    #[cfg(not(target_os = "windows"))]
    last_check_wall: std::time::SystemTime,
    /// Tolerance in milliseconds.
    tolerance_ms: i64,
}

// ─── Public API ─────────────────────────────────────────────────────────────

impl MonotonicClock {
    /// Create a new clock with the current time as baseline.
    pub fn new() -> Self {
        #[cfg(target_os = "windows")]
        {
            windows_new_clock()
        }
        #[cfg(not(target_os = "windows"))]
        {
            let now = std::time::Instant::now();
            let wall = std::time::SystemTime::now();
            Self {
                baseline_instant: now,
                baseline_wall: wall,
                last_check_wall: wall,
                tolerance_ms: DEFAULT_TOLERANCE_MS,
            }
        }
    }

    /// Create a clock with a custom tolerance (milliseconds).
    pub fn with_tolerance(tolerance_ms: i64) -> Self {
        let mut clock = Self::new();
        clock.tolerance_ms = tolerance_ms;
        clock
    }

    /// Check for time rollback by comparing monotonic progress against
    /// wall-clock progress.
    ///
    /// Returns a [`TimeVerdict`] describing the drift and whether a rollback
    /// was detected.
    pub fn check_for_rollback(&mut self) -> Result<TimeVerdict, AppError> {
        #[cfg(target_os = "windows")]
        {
            windows_check_rollback(self)
        }
        #[cfg(not(target_os = "windows"))]
        {
            unix_check_rollback(self)
        }
    }
}

// ─── Unix / macOS implementation ───────────────────────────────────────────

#[cfg(not(target_os = "windows"))]
fn unix_check_rollback(clock: &mut MonotonicClock) -> Result<TimeVerdict, AppError> {
    let now_instant = std::time::Instant::now();
    let now_wall = std::time::SystemTime::now();

    // Elapsed monotonic time since baseline.
    let mono_elapsed = now_instant.duration_since(clock.baseline_instant);
    let mono_elapsed_ms = mono_elapsed.as_millis() as i64;

    // Expected wall-clock progress = monotonic elapsed (they should track).
    let expected_wall = clock
        .baseline_wall
        .checked_add(mono_elapsed)
        .unwrap_or(clock.baseline_wall);

    // Actual wall-clock drift from expected.
    let wall_drift = if now_wall >= expected_wall {
        now_wall
            .duration_since(expected_wall)
            .unwrap_or_default()
            .as_millis() as i64
    } else {
        -(expected_wall
            .duration_since(now_wall)
            .unwrap_or_default()
            .as_millis() as i64)
    };

    // Check for rollback: wall time went backward from last check.
    let rollback = if now_wall < clock.last_check_wall {
        let back = clock
            .last_check_wall
            .duration_since(now_wall)
            .unwrap_or_default()
            .as_millis() as i64;
        back > clock.tolerance_ms
    } else {
        false
    };

    // Also check if wall time lags expected by more than tolerance.
    let lag_detected = wall_drift < -clock.tolerance_ms;

    clock.last_check_wall = now_wall;

    let rollback_detected = rollback || lag_detected;
    let explanation = if rollback_detected {
        format!(
            "Time rollback detected: wall_drift={wall_drift}ms, mono_elapsed={mono_elapsed_ms}ms"
        )
    } else {
        "No rollback detected".into()
    };

    Ok(TimeVerdict {
        rollback_detected,
        wall_drift_ms: wall_drift,
        monotonic_drift_ms: 0, // Monotonic cannot drift from itself.
        explanation,
    })
}

// ─── Windows implementation ────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod win {
    use std::ffi::c_void;

    #[link(name = "kernel32")]
    extern "system" {
        pub fn QueryPerformanceCounter(lpPerformanceCount: *mut i64) -> i32;
        pub fn QueryPerformanceFrequency(lpFrequency: *mut i64) -> i32;
        pub fn GetSystemTimeAsFileTime(lpSystemTimeAsFileTime: *mut i64);
    }
}

#[cfg(target_os = "windows")]
fn windows_new_clock() -> MonotonicClock {
    let (qpc, freq, wall) = unsafe {
        let mut qpc: i64 = 0;
        let mut freq: i64 = 0;
        let mut wall: i64 = 0;
        win::QueryPerformanceCounter(&mut qpc);
        win::QueryPerformanceFrequency(&mut freq);
        win::GetSystemTimeAsFileTime(&mut wall);
        (qpc, freq, wall)
    };

    MonotonicClock {
        baseline_qpc: qpc,
        qpc_frequency: freq.max(1), // prevent div-by-zero
        baseline_wall: wall,
        last_check_wall: wall,
        tolerance_ms: DEFAULT_TOLERANCE_MS,
    }
}

#[cfg(target_os = "windows")]
fn windows_check_rollback(clock: &mut MonotonicClock) -> Result<TimeVerdict, AppError> {
    let (now_qpc, now_wall) = unsafe {
        let mut qpc: i64 = 0;
        let mut wall: i64 = 0;
        win::QueryPerformanceCounter(&mut qpc);
        win::GetSystemTimeAsFileTime(&mut wall);
        (qpc, wall)
    };

    // Monotonic elapsed in ms.
    let qpc_delta = now_qpc - clock.baseline_qpc;
    let mono_elapsed_ms = qpc_delta * 1000 / clock.qpc_frequency;

    // Expected wall time = baseline + monotonic elapsed.
    // FILETIME is in 100ns intervals, so 1ms = 10_000 intervals.
    let expected_wall = clock.baseline_wall + mono_elapsed_ms * 10_000;

    // Wall drift: positive = clock ahead, negative = clock behind.
    let wall_drift_100ns = now_wall - expected_wall;
    let wall_drift_ms = wall_drift_100ns / 10_000;

    // Check for rollback from last check.
    let rollback = if now_wall < clock.last_check_wall {
        let back_100ns = clock.last_check_wall - now_wall;
        let back_ms = back_100ns / 10_000;
        back_ms > clock.tolerance_ms
    } else {
        false
    };

    let lag_detected = wall_drift_ms < -clock.tolerance_ms;
    let rollback_detected = rollback || lag_detected;

    clock.last_check_wall = now_wall;

    let explanation = if rollback_detected {
        format!(
            "Time rollback detected: wall_drift={wall_drift_ms}ms, mono_elapsed={mono_elapsed_ms}ms"
        )
    } else {
        "No rollback detected".into()
    };

    Ok(TimeVerdict {
        rollback_detected,
        wall_drift_ms,
        monotonic_drift_ms: 0,
        explanation,
    })
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_clock_captures_baseline() {
        let clock = MonotonicClock::new();
        // Baseline should be captured (no panic).
        // Verify tolerance is set.
        assert_eq!(clock.tolerance_ms, DEFAULT_TOLERANCE_MS);
    }

    #[test]
    fn no_rollback_returns_false() {
        let mut clock = MonotonicClock::new();
        // Check immediately — no time has passed, no rollback.
        let verdict = clock.check_for_rollback().unwrap();
        assert!(!verdict.rollback_detected);
    }

    #[test]
    fn simulated_rollback_detected() {
        // Simulate a rollback by manually setting last_check_wall to the future.
        let mut clock = MonotonicClock::with_tolerance(100);

        #[cfg(not(target_os = "windows"))]
        {
            // Set last check to 10 seconds in the future.
            clock.last_check_wall = std::time::SystemTime::now()
                + std::time::Duration::from_secs(10);

            let verdict = clock.check_for_rollback().unwrap();
            assert!(
                verdict.rollback_detected,
                "should detect rollback: {}",
                verdict.explanation
            );
        }

        #[cfg(target_os = "windows")]
        {
            // Set last check to 10 seconds in the future (10s = 100_000_000 100ns intervals).
            clock.last_check_wall += 100_000_000;
            let verdict = clock.check_for_rollback().unwrap();
            assert!(verdict.rollback_detected);
        }
    }

    #[test]
    fn monotonic_drift_calculation_correct() {
        let mut clock = MonotonicClock::new();
        let verdict = clock.check_for_rollback().unwrap();

        // Wall drift should be small (< 1000ms for a quick check).
        assert!(
            verdict.wall_drift_ms.abs() < 1000,
            "wall drift should be < 1000ms, got {}",
            verdict.wall_drift_ms
        );
    }

    #[test]
    fn time_verdict_serializes() {
        let verdict = TimeVerdict {
            rollback_detected: false,
            wall_drift_ms: 42,
            monotonic_drift_ms: 0,
            explanation: "test".into(),
        };
        let json = serde_json::to_string(&verdict).unwrap();
        assert!(json.contains("rollback_detected"));
        assert!(json.contains("42"));
    }

    #[test]
    fn with_tolerance_sets_custom_value() {
        let clock = MonotonicClock::with_tolerance(1000);
        assert_eq!(clock.tolerance_ms, 1000);
    }

    #[test]
    fn multiple_checks_maintain_state() {
        let mut clock = MonotonicClock::new();

        // Multiple checks should not cause false positives.
        for _ in 0..5 {
            let verdict = clock.check_for_rollback().unwrap();
            assert!(!verdict.rollback_detected);
        }
    }
}

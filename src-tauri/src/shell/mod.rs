// SLICE_C_STUB: scanner wiring stub. Real implementation (rdev global key
// hook + Tauri events) lives in Slice D. Slice C publishes a "scan target"
// (which form is focused) and consumes scan events through these helpers,
// which are no-ops until Slice D lands.

use std::sync::Mutex;

/// Where scanned barcodes should be routed. Defaults to the sales cart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanTarget {
    Sales,
    Inward,
    None,
}

static TARGET: Mutex<ScanTarget> = Mutex::new(ScanTarget::Sales);

/// Called from the POS UI when a screen wants to "claim" the scanner
/// (e.g. when the Inward page opens).
pub fn set_scan_target(t: ScanTarget) {
    if let Ok(mut g) = TARGET.lock() {
        *g = t;
    }
}

pub fn current_scan_target() -> ScanTarget {
    TARGET.lock().map(|g| *g).unwrap_or(ScanTarget::None)
}

/// Called by the global hook (Slice D) to deliver a barcode. Returns true if
/// accepted (matches current target's contract); false otherwise. In Slice C
/// we don't have a JS bridge — we just log via `tracing` once it lands. Until
/// then this returns false.
pub fn deliver_scan(_barcode: &str) -> bool {
    // Real impl: emit a Tauri event 'scan' with the barcode, picked up by
    // whichever React page is listening. Slice D wires rdev.
    false
}

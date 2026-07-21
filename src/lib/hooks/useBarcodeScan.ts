import { useEffect, useRef } from "react";

import { listen } from "@tauri-apps/api/event";

export interface ScanEventPayload {
  barcode: string;
  ts: number;
  terminator: string;
}

export interface UseBarcodeScanOptions {
  /**
   * Called for every scan emitted by the Rust hook. The Rust hook reads
   * `scanner_min_length` and `scanner_avg_ms_per_char` from settings on every
   * keystroke, so timing-tuning happens in the Settings → Scanner panel
   * without restarting the hook.
   *
   * IMPORTANT: This callback may fire from a Tauri event handler. Keep it
   * pure or wrap state updates in `queueMicrotask`/`flushSync` as needed.
   */
  onScan: (barcode: string) => void;
  /**
   * Optional filter — return false to ignore the event. Useful to drop
   * scans that arrive while the wrong page is mounted.
   */
  enabled?: boolean;
}

/**
 * Listens to the Tauri "barcode:scan" event emitted by `src-tauri/src/scan.rs`.
 *
 * On macOS dev the Rust hook is disabled (see `lib.rs` — TSMGetInputSourceProperty
 * dispatch_assert_queue crash). To test scanner integration on macOS, expose the
 * page and use the manual "Simulate scan" button in Settings → Scanner which
 * calls the same event path via the dev bridge.
 *
 * On Windows, plug in a USB HID keyboard-wedge scanner — no driver required.
 * The hook buffers keystrokes based on `scanner_min_length` /
 * `scanner_avg_ms_per_char` and emits a single event per scan.
 */
export function useBarcodeScan({ onScan, enabled = true }: UseBarcodeScanOptions): void {
  const cbRef = useRef(onScan);
  cbRef.current = onScan;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const unlistenPromise = listen<ScanEventPayload>("barcode:scan", (e) => {
      cbRef.current(e.payload.barcode);
    });
    return () => {
      cancelled = true;
      void unlistenPromise.then((fn) => fn());
    };
  }, [enabled]);
}
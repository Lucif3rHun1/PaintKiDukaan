import { useEffect, useRef, useState } from "react";

import { listen } from "@tauri-apps/api/event";

export interface BarcodeInputProps {
  /** Called when a scan event arrives from the Rust hook. */
  onScan: (barcode: string) => void;
  /** Visual placeholder text. */
  placeholder?: string;
  className?: string;
}

interface ScanEventPayload {
  barcode: string;
  ts: number;
  terminator: string;
}

/**
 * Hidden input that receives scan events emitted by the Rust scanner hook.
 *
 * The element is intentionally not focusable via tab; the wedge writes
 * directly into a buffer in Rust. This component is a passive listener
 * that calls `onScan` for every event.
 */
export function BarcodeInput({
  onScan,
  placeholder = "Scan a barcode…",
  className,
}: BarcodeInputProps) {
  const [last, setLast] = useState<string | null>(null);
  const cbRef = useRef(onScan);
  cbRef.current = onScan;

  useEffect(() => {
    const un = listen<ScanEventPayload>("barcode:scan", (e) => {
      setLast(e.payload.barcode);
      cbRef.current(e.payload.barcode);
    });
    return () => {
      void un.then((fn) => fn());
    };
  }, []);

  return (
    <div className={className}>
      <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-3 text-sm text-slate-600">
        {placeholder}
      </div>
      {last !== null && (
        <div className="mt-1 text-xs text-slate-500">last: {last}</div>
      )}
    </div>
  );
}

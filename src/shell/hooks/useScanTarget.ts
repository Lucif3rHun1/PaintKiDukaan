import { useEffect } from "react";

import { ipc, type ScanTarget } from "../lib/ipc";
import { useScanTargetStore } from "../store/scanTarget";

/**
 * Set the global scan target on mount, restore `null` on unmount.
 *
 * The route handler that owns the scanner focus (sales, inward, stocktake)
 * calls `useScanTarget('sales')` etc. The Rust scanner hook reads the
 * current target from app state and discards scans when the target is
 * `null` or `'locked'`.
 */
export function useScanTarget(target: ScanTarget): void {
  const setTarget = useScanTargetStore((s) => s.setTarget);

  useEffect(() => {
    setTarget(target);
    void ipc.setScanTarget(target ?? "none");
    return () => {
      setTarget(null);
      void ipc.setScanTarget("none");
    };
  }, [target, setTarget]);
}

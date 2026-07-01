import { useCallback, useEffect, useRef, useState } from "react";

// ── Module-level dirty state for cross-component nav guards ──
let _anyDirty = false;

export function isAnyFormDirty(): boolean {
  return _anyDirty;
}

// ── Hook ──────────────────────────────────────────────────────
interface UseDirtyFormReturn {
  isDirty: boolean;
  markDirty: () => void;
  resetDirty: () => void;
}

export function useDirtyForm(): UseDirtyFormReturn {
  const isDirty = useRef(false);
  const [dirty, setDirty] = useState(false);

  const markDirty = useCallback(() => {
    if (!isDirty.current) {
      isDirty.current = true;
      setDirty(true);
      _anyDirty = true;
    }
  }, []);

  const resetDirty = useCallback(() => {
    isDirty.current = false;
    setDirty(false);
    _anyDirty = false;
  }, []);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirty.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => {
      window.removeEventListener("beforeunload", handler);
      // Reset module-level singleton on unmount to prevent stale dirty state leaking to next form
      isDirty.current = false;
      _anyDirty = false;
    };
  }, []);

  return { isDirty: dirty, markDirty, resetDirty };
}

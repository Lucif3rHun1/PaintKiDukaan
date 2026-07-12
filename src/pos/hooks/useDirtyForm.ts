import { useCallback, useEffect, useRef, useState } from "react";

// ── Module-level dirty counter for cross-component nav guards ──
// ponytail: counter instead of boolean — multiple forms can be dirty simultaneously
let _dirtyCount = 0;

export function isAnyFormDirty(): boolean {
  return _dirtyCount > 0;
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
      _dirtyCount++;
    }
  }, []);

  const resetDirty = useCallback(() => {
    if (isDirty.current) {
      isDirty.current = false;
      setDirty(false);
      _dirtyCount = Math.max(0, _dirtyCount - 1);
    }
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
      // Decrement module-level counter on unmount
      if (isDirty.current) {
        isDirty.current = false;
        _dirtyCount = Math.max(0, _dirtyCount - 1);
      }
    };
  }, []);

  return { isDirty: dirty, markDirty, resetDirty };
}

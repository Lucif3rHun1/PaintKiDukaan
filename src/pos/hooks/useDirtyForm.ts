import { useCallback, useEffect, useRef, useState } from "react";

// ── Module-level dirty state for cross-component nav guards ──
let _anyDirty = false;
let _onDirtyCheck: (() => boolean) | null = null;

export function registerDirtyChecker(checker: () => boolean) {
  _onDirtyCheck = checker;
}

export function unregisterDirtyChecker() {
  _onDirtyCheck = null;
  _anyDirty = false;
}

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
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  return { isDirty: dirty, markDirty, resetDirty };
}

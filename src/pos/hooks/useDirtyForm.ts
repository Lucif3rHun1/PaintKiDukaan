import { useCallback, useEffect, useRef, useState } from "react";

interface UseDirtyFormReturn {
  isDirty: boolean;
  markDirty: () => void;
  resetDirty: () => void;
  /** Ref that is true when the form has unsaved changes. */
  canLeave: React.MutableRefObject<boolean>;
  /** Wrap navigation callback — shows confirm dialog if dirty. */
  confirmLeave: (onLeave: () => void) => void;
}

export function useDirtyForm(): UseDirtyFormReturn {
  const isDirty = useRef(false);
  const [dirty, setDirty] = useState(false);

  const markDirty = useCallback(() => {
    if (!isDirty.current) {
      isDirty.current = true;
      setDirty(true);
    }
  }, []);

  const resetDirty = useCallback(() => {
    isDirty.current = false;
    setDirty(false);
  }, []);

  // Block browser close/refresh when dirty
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

  // ponytail: window.confirm placeholder; replace with UnsavedChangesModal in task 8
  const confirmLeave = useCallback(
    (onLeave: () => void) => {
      if (!isDirty.current) {
        onLeave();
        return;
      }
      const confirmed = window.confirm(
        "You have unsaved changes. Discard?"
      );
      if (confirmed) {
        resetDirty();
        onLeave();
      }
    },
    [resetDirty]
  );

  return {
    isDirty: dirty,
    markDirty,
    resetDirty,
    canLeave: isDirty,
    confirmLeave,
  };
}

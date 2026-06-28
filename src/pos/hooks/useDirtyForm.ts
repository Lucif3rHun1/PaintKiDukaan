import { useCallback, useEffect, useRef, useState } from "react";

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
    }
  }, []);

  const resetDirty = useCallback(() => {
    isDirty.current = false;
    setDirty(false);
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

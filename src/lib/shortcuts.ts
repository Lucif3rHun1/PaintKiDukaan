import { useEffect } from "react";

export interface ShortcutDef {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
  scope?: string;
  description: string;
  onMatch: () => void;
  allowInInputs?: boolean;
  preventDefault?: boolean;
}

export function useShortcut(def: ShortcutDef) {
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const isEditable =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable;
      if (isEditable && !def.allowInInputs) return;
      if (e.key.toLowerCase() !== def.key.toLowerCase()) return;
      if (def.ctrl && !e.ctrlKey) return;
      if (def.meta && !e.metaKey) return;
      if (def.alt && !e.altKey) return;
      if (def.shift && !e.shiftKey) return;
      if (def.preventDefault !== false) e.preventDefault();
      def.onMatch();
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [def.key, def.ctrl, def.meta, def.alt, def.shift, def.allowInInputs]);
}

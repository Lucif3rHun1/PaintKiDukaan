import { useEffect, useRef } from "react";

export type ShortcutScope = "global" | "page";

export interface ShortcutDef {
  /** Key string: "F1".."F12", "a".."z", "0".."9", "?", "Enter", "Escape", etc. Case-insensitive. */
  key: string;
  /** Ctrl on Win/Linux OR Cmd on Mac. Cross-platform "primary modifier". */
  ctrl?: boolean;
  /** Same as ctrl — kept for semantic clarity. */
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
  /** "global" = fires even when a modal is open. "page" = suppressed while modal open. Default "page". */
  scope?: ShortcutScope;
  /** Allow firing while focus is in INPUT/TEXTAREA/SELECT/contenteditable. */
  allowInInputs?: boolean;
  /** Default true. Pass false to NOT call preventDefault (e.g., native dialog Esc). */
  preventDefault?: boolean;
  description: string;
  onMatch: (e: KeyboardEvent) => void;
}

// Modal-scope counter. InlineDialog push/pops on open/close. Page-scope shortcuts
// are suppressed while count > 0.
let modalScopeCount = 0;

export function isModalOpen(): boolean {
  return modalScopeCount > 0;
}

export function pushModalScope(): void {
  modalScopeCount += 1;
}

export function popModalScope(): void {
  modalScopeCount = Math.max(0, modalScopeCount - 1);
}
// ponytail: counter, not stack — fine for nested modals provided each one opens
// and closes once. upgrade to a stack map when nesting needs ≥3 + independent close ordering.

export function useShortcut(def: ShortcutDef): void {
  // ponytail: ref captures latest onMatch — fixes stale-closure bug where deps array
  // omitted `onMatch` and older handlers ran with stale render data.
  const ref = useRef(def);
  ref.current = def;

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (def.scope !== "global" && isModalOpen()) return;
      if (!matchKey(e, def)) return;
      if (!def.allowInInputs && isTypingTarget(e.target)) return;
      if (def.preventDefault !== false) e.preventDefault();
      ref.current.onMatch(e);
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // ponytail: deps keyed on signature, not closure identity. onMatch via ref.
  }, [
    def.key,
    def.ctrl,
    def.meta,
    def.alt,
    def.shift,
    def.scope,
    def.allowInInputs,
    def.preventDefault,
  ]);
}

function matchKey(e: KeyboardEvent, def: ShortcutDef): boolean {
  if (e.key.toLowerCase() !== def.key.toLowerCase()) return false;
  // ctrl and meta are aliases — accept either physical modifier.
  const wantPrimary = !!(def.ctrl || def.meta);
  const hasPrimary = e.ctrlKey || e.metaKey;
  if (wantPrimary && !hasPrimary) return false;
  if (!!def.alt !== e.altKey) return false;
  if (!!def.shift !== e.shiftKey) return false;
  return true;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}
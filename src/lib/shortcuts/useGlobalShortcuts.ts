import { useShortcut } from "../shortcuts";

export interface GlobalShortcutsOptions {
  readonly onSave?: () => void;
  readonly onHelp?: () => void;
}

function isShortcutOverlayOpen(): boolean {
  return document.querySelector("dialog[data-shortcut-overlay-open][open]") !== null;
}

/**
 * App-wide shortcuts. Scope: "global" — fire even while modals are open.
 * Currently: Ctrl/Cmd+S → save, ? (Shift+/) → toggle help panel, F1 → same.
 */
export function useGlobalShortcuts(opts: GlobalShortcutsOptions): void {
  const { onSave, onHelp } = opts;

  useShortcut({
    key: "s",
    ctrl: true,
    meta: true,
    scope: "global",
    description: "Save",
    allowInInputs: true,
    onMatch: () => {
      if (!isShortcutOverlayOpen()) onSave?.();
    },
  });

  useShortcut({
    key: "?",
    shift: true,
    scope: "global",
    description: "Toggle shortcut panel",
    onMatch: () => onHelp?.(),
  });

  useShortcut({
    key: "F1",
    scope: "global",
    description: "Toggle shortcut panel",
    onMatch: () => onHelp?.(),
  });
}

export { isShortcutOverlayOpen };

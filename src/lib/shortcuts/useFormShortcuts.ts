import { useShortcut } from "../shortcuts";

export interface FormShortcutsOptions {
  onSubmit: () => void;
  onCancel?: () => void;
  /**
   * Default true. Set false when the page already uses a native `<form onSubmit>`,
   * so Enter inside an input doesn't fire `onSubmit` twice (browser auto-submit + us).
   */
  submitOnEnter?: boolean;
}

/**
 * Standard form shortcuts: F9 → submit, Esc → cancel, Enter → submit.
 * Page-scope: suppressed while any InlineDialog is open.
 */
export function useFormShortcuts(opts: FormShortcutsOptions): void {
  const { onSubmit, onCancel, submitOnEnter = true } = opts;

  useShortcut({
    key: "F9",
    scope: "page",
    description: "Save",
    preventDefault: true,
    onMatch: () => onSubmit(),
  });

  useShortcut({
    key: "Escape",
    scope: "page",
    description: "Cancel",
    preventDefault: false,
    onMatch: () => onCancel?.(),
  });

  useShortcut({
    key: "Enter",
    scope: "page",
    description: "Submit",
    allowInInputs: true,
    preventDefault: submitOnEnter,
    onMatch: (e) => {
      if (!submitOnEnter) return;
      const t = e.target;
      if (t instanceof HTMLElement && t.tagName === "TEXTAREA") return;
      onSubmit();
    },
  });
}
import { useShortcut } from "../shortcuts";

export interface FocusShortcutOptions {
  key: string;
  /** CSS selector for the input to focus. */
  selector: string;
  description: string;
  /** Select all text in the focused input. Default true. */
  select?: boolean;
}

/**
 * Press a key to focus a DOM element matching `selector`. No-op if element missing.
 */
export function useFocusShortcut({
  key,
  selector,
  description,
  select = true,
}: FocusShortcutOptions): void {
  useShortcut({
    key,
    scope: "page",
    description,
    preventDefault: true,
    onMatch: () => {
      const el = document.querySelector<HTMLElement>(selector);
      if (!el) return;
      el.focus({ preventScroll: false });
      if (select && el instanceof HTMLInputElement) el.select();
    },
  });
}
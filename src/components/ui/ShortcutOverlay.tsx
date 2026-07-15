import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";
import { X } from "lucide-react";
import { popModalScope, pushModalScope } from "../../lib/shortcuts";
import { cn } from "./cn";

export interface ShortcutItem {
  readonly key: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
  readonly label: string;
}

export interface ShortcutGroup {
  readonly title: string;
  readonly items: readonly ShortcutItem[];
}

interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly groups: readonly ShortcutGroup[];
}

function formatShortcut(s: ShortcutItem): string {
  return [
    s.ctrl ? "Ctrl+" : "",
    s.meta ? "⌘" : "",
    s.shift ? "Shift+" : "",
    s.alt ? "Alt+" : "",
    s.key,
  ].join("");
}

export function ShortcutOverlay({ open, onClose, groups }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [isClosing, setIsClosing] = useState(true);
  const [entered, setEntered] = useState(false);

  const requestClose = useCallback(() => {
    if (isClosing) return;
    setIsClosing(true);
    onClose();
  }, [isClosing, onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (!dialog.open) dialog.showModal();
      const frame = requestAnimationFrame(() => {
        setIsClosing(false);
        setEntered(true);
      });
      return () => cancelAnimationFrame(frame);
    }

    if (!dialog.open) {
      setIsClosing(true);
      setEntered(false);
      return;
    }

    setIsClosing(true);
    setEntered(false);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    if (!open || !dialogRef.current?.open) return;
    dialogRef.current
      .querySelector<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      ?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    pushModalScope();
    return () => popModalScope();
  }, [open]);

  const handleBackdrop = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) requestClose();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== "Tab") return;
    const focusTargets = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[data-shortcut-focus]"),
    );
    const first = focusTargets[0];
    const last = focusTargets.at(-1);
    if (!first || !last) return;

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      data-shortcut-overlay-open
      data-state={entered ? "open" : "closed"}
      onClick={handleBackdrop}
      onKeyDown={handleKeyDown}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onClose={() => {
        setEntered(false);
        if (open) onClose();
      }}
      aria-labelledby={titleId}
      className={cn(
        "m-auto overflow-visible rounded-xl border-0 bg-transparent p-0 backdrop:bg-foreground/60 backdrop:opacity-0 backdrop:transition-opacity backdrop:duration-normal backdrop:ease-out motion-reduce:backdrop:transition-none motion-reduce:backdrop:opacity-100",
        isClosing
          ? "backdrop:opacity-0"
          : "backdrop:opacity-100",
      )}
    >
      <div
        onTransitionEnd={(event) => {
          if (event.propertyName === "opacity" && !open && isClosing) {
            dialogRef.current?.close();
          }
        }}
        className={cn(
          "mx-4 w-full max-w-2xl rounded-lg border border-border bg-card p-6 text-card-foreground shadow-2xl transition-[opacity,transform] duration-normal ease-out will-change-transform motion-reduce:transition-none motion-reduce:opacity-100 motion-reduce:scale-100",
          isClosing ? "scale-[0.97] opacity-0" : "scale-100 opacity-100",
        )}
      >
        <div className="mb-4 flex items-center justify-between">
          <div id={titleId} className="text-sm font-semibold">Keyboard Shortcuts</div>
          <button
            data-shortcut-focus
            type="button"
            onClick={requestClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div
          data-shortcut-focus
          tabIndex={0}
          role="region"
          aria-label="Shortcut list"
          className="grid gap-6 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:grid-cols-2"
        >
          {groups.map((group, idx) => (
            <div key={idx}>
              <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {group.title}
              </div>
              <div className="space-y-1.5">
                {group.items.map((item, i) => (
                  <div key={i} className="flex items-center justify-between gap-4 text-sm">
                    <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                      {formatShortcut(item)}
                    </kbd>
                    <span className="text-muted-foreground">{item.label}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 text-[10px] text-muted-foreground">
          Press <kbd className="rounded border border-border bg-muted px-1 py-px font-mono">?</kbd> again to close.
        </div>
      </div>
    </dialog>
  );
}

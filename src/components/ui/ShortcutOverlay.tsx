import { useEffect } from "react";
import { X } from "lucide-react";
import { useShortcut } from "../../lib/shortcuts";

export interface ShortcutItem {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
  label: string;
}

export interface ShortcutGroup {
  title: string;
  items: ShortcutItem[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  groups: ShortcutGroup[];
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
  // Close on Esc
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Click outside closes
  const handleBackdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
      onClick={handleBackdrop}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div className="mx-4 w-full max-w-2xl rounded-lg border border-border bg-card p-6 text-card-foreground shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div className="text-sm font-semibold">Keyboard Shortcuts</div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
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
    </div>
  );
}

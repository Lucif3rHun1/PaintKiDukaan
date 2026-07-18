import { useState } from "react";
import { Keyboard, X } from "lucide-react";
import { useShortcut } from "../../lib/shortcuts";
import { cn } from "./cn";

interface Shortcut {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
  label: string;
}

interface Props {
  shortcuts?: Shortcut[];
  group?: string;
  className?: string;
}

export function ShortcutsHint({ shortcuts = [], group: _group, className }: Props) {
  const [open, setOpen] = useState(false);

  useShortcut({
    key: "?",
    shift: true,
    description: "Toggle shortcuts panel",
    onMatch: () => setOpen((v) => !v),
  });

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className={cn("text-muted-foreground hover:text-foreground", className)}
        title="Keyboard shortcuts (?)"
      >
        <Keyboard className="h-4 w-4" />
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-3 shadow-xl">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-muted-foreground">
          Keyboard Shortcuts
        </span>
        <button
          onClick={() => setOpen(false)}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="space-y-1">
        {shortcuts.map((s: Shortcut) => (
          <div
            key={s.key}
            className="flex items-center justify-between gap-4"
          >
            <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-xs font-mono text-muted-foreground">
              {s.ctrl ? "Ctrl+" : ""}
              {s.meta ? "⌘" : ""}
              {s.shift ? "Shift+" : ""}
              {s.alt ? "Alt+" : ""}
              {s.key}
            </kbd>
            <span className="text-xs text-muted-foreground">{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

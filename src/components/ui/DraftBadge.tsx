import { useEffect, useState } from "react";
import type { SaveStatus } from "../../pos/hooks/useAutosave";

interface DraftBadgeProps {
  status: SaveStatus;
  draft: { updated_at: number } | null;
}

export function DraftBadge({ status, draft }: DraftBadgeProps) {
  const [show, setShow] = useState(status === "saved" || status === "error");

  useEffect(() => {
    if (status === "saved") {
      setShow(true);
      const t = setTimeout(() => setShow(false), 8000);
      return () => clearTimeout(t);
    }
    if (status === "error") {
      setShow(true);
      const t = setTimeout(() => setShow(false), 12000);
      return () => clearTimeout(t);
    }
    setShow(status !== "idle");
  }, [status]);

  if (!show && status !== "saving" && status !== "dirty") return null;

  const time = draft
    ? new Date(draft.updated_at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

  switch (status) {
    case "dirty":
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-400">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
          </span>
          Unsaved changes
        </span>
      );

    case "saving":
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
          <svg
            className="h-3 w-3 animate-spin"
            viewBox="0 0 24 24"
            fill="none"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="3"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          Saving…
        </span>
      );

    case "saved":
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-400">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          Draft saved {time}
        </span>
      );

    case "error":
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-0.5 text-xs font-medium text-red-400">
          <span className="h-2 w-2 rounded-full bg-red-500" />
          Save failed
        </span>
      );

    default:
      return null;
  }
}

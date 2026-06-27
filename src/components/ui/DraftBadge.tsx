import { useEffect, useState } from "react";

type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

interface DraftBadgeProps {
  status: SaveStatus;
  draft: { updated_at: number } | null;
}

export function DraftBadge({ status, draft }: DraftBadgeProps) {
  const [show, setShow] = useState(status !== "idle");

  useEffect(() => {
    if (status === "saved") {
      setShow(true);
      const timer = setTimeout(() => setShow(false), 8000);
      return () => clearTimeout(timer);
    }
    setShow(status !== "idle");
  }, [status]);

  if (!show) return null;

  if (status === "dirty") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-amber-500">
        <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />
        Unsaved
      </span>
    );
  }

  if (status === "saving") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-primary">
        <span className="h-2 w-2 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        Saving…
      </span>
    );
  }

  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-red-500">
        <span className="h-2 w-2 rounded-full bg-red-500" />
        Save failed
      </span>
    );
  }

  // status === "saved"
  if (!draft) return null;

  const time = new Date(draft.updated_at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-emerald-500">
      <span className="h-2 w-2 rounded-full bg-emerald-500" />
      Draft saved {time}
    </span>
  );
}

import type { Draft } from "../../domain/types";

interface DraftBadgeProps {
  draft: Draft | null;
}

export function DraftBadge({ draft }: DraftBadgeProps) {
  if (!draft) return null;

  const time = new Date(draft.updated_at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-muted-foreground/20 bg-muted/50 px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
      Draft · {time}
    </span>
  );
}

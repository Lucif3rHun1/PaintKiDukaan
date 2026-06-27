import { Badge } from "./Badge";

interface DraftBadgeProps {
  draft: { updated_at: number } | null;
}

export function DraftBadge({ draft }: DraftBadgeProps) {
  if (!draft) return null;

  const time = new Date(draft.updated_at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <Badge variant="muted" className="text-xs">
      Draft saved {time}
    </Badge>
  );
}

import { formatRupeesFromPaise, formatRupeesCompact } from "../../lib/money";
import { cn } from "./cn";

export interface MoneyProps {
  paise: number;
  compact?: boolean;
  muted?: boolean;
  negative?: boolean;
  className?: string;
}

export function Money({ paise, compact, muted, negative, className }: MoneyProps) {
  const text = compact
    ? formatRupeesCompact(paise)
    : formatRupeesFromPaise(paise);
  return (
    <span
      className={cn(
        "tabular-nums",
        muted && "text-muted-foreground",
        (negative || paise < 0) && "text-destructive",
        className,
      )}
    >
      {text}
    </span>
  );
}

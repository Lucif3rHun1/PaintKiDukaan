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

// ponytail: keep inner structure (value flex-1 justify-end) in sync with
// MoneyInput — read-only text gets ₹ from formatRupeesFromPaise(), not a second
// prefix span. Don't simplify to a single text span.
export interface MoneyStaticProps {
  paise: number;
  className?: string;
  tone?: "default" | "muted" | "destructive" | "success";
}

export function MoneyStatic({
  paise,
  className,
  tone = "default",
}: MoneyStaticProps) {
  return (
    <div className={cn("flex items-center justify-end gap-1.5", className)}>
      <span
        className={cn(
          "tabular-nums",
          tone === "muted" && "text-muted-foreground",
          tone === "destructive" && "text-destructive",
          tone === "success" && "text-success",
        )}
      >
        {formatRupeesFromPaise(paise)}
      </span>
    </div>
  );
}

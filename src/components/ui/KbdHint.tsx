import { cn } from "./cn";

interface KbdHintProps {
  keys: string | string[];
  className?: string;
}

/**
 * Inline kbd chip(s) for keyboard shortcut hints on buttons or toolbar actions.
 * Hidden below `md` breakpoint (mobile devices don't have keyboards).
 */
export function KbdHint({ keys, className }: KbdHintProps) {
  const arr = Array.isArray(keys) ? keys : [keys];
  return (
    <span
      aria-hidden="true"
      className={cn(
        "hidden md:inline-flex items-center gap-0.5 pl-2 text-xs text-muted-foreground",
        className,
      )}
    >
      {arr.map((k, i) => (
        <kbd
          key={i}
          className="inline-flex items-center justify-center min-w-[1.5rem] rounded border border-border bg-muted px-1 py-px font-mono text-[0.7rem] leading-tight text-foreground"
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}
import { useEffect, useState } from "react";

import { parseRupeesToPaise } from "../../lib/money";
import { cn } from "./cn";

const EDIT_FORMAT = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export interface MoneyInputProps {
  value: number;
  onChange: (paise: number) => void;
  disabled?: boolean;
  required?: boolean;
  min?: number;
  className?: string;
  tone?: "light" | "dark";
}

function formatEditableValue(paise: number): string {
  if (!Number.isFinite(paise) || paise === 0) return "0.00";
  return EDIT_FORMAT.format(paise / 100);
}

export function MoneyInput({
  value,
  onChange,
  disabled = false,
  required = false,
  min,
  className,
  tone = "light",
}: MoneyInputProps) {
  const [focused, setFocused] = useState(false);
  const [display, setDisplay] = useState(() => formatEditableValue(value));

  useEffect(() => {
    if (!focused) setDisplay(formatEditableValue(value));
  }, [focused, value]);

  function commitValue() {
    if (display.trim() === "") {
      onChange(0);
      setDisplay("0.00");
      return;
    }

    const nextPaise = parseRupeesToPaise(display);
    onChange(nextPaise);
    setDisplay(formatEditableValue(nextPaise));
  }

  return (
    <div className={cn("flex items-center justify-end gap-1.5", className)}>
      <span
        className={cn(
          "shrink-0 text-sm tabular-nums",
          tone === "dark" ? "text-muted-foreground" : "text-muted-foreground",
        )}
      >
        ₹
      </span>
      <input
        type="text"
        inputMode="decimal"
        value={display}
        onChange={(event) => setDisplay(event.target.value)}
        onFocus={() => {
          setFocused(true);
          setDisplay(formatEditableValue(value));
        }}
        onBlur={() => {
          setFocused(false);
          commitValue();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        disabled={disabled}
        required={required}
        min={min}
        className={cn(
          "w-full rounded border px-2 py-1.5 text-right text-sm tabular-nums outline-none transition-colors disabled:cursor-not-allowed",
          tone === "dark"
            ? "border-border bg-background text-foreground placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-50"
            : "border-border bg-background text-foreground placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:bg-muted disabled:text-muted-foreground",
        )}
      />
    </div>
  );
}

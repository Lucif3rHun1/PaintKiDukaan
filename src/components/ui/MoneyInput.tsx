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
  if (!Number.isFinite(paise) || paise === 0) return "";
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
      setDisplay("");
      return;
    }

    const nextPaise = parseRupeesToPaise(display);
    onChange(nextPaise);
    setDisplay(formatEditableValue(nextPaise));
  }

  return (
    <div className={cn("relative", className)}>
      <span
        className={cn(
          "pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-sm",
          tone === "dark" ? "text-zinc-500" : "text-slate-500",
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
          "w-full rounded border px-2 py-1.5 pl-6 text-sm tabular-nums outline-none transition-colors disabled:cursor-not-allowed",
          tone === "dark"
            ? "border-white/10 bg-zinc-950 text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/20 disabled:opacity-50"
            : "border-slate-300 bg-white text-slate-900 placeholder:text-slate-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 disabled:bg-slate-100 disabled:text-slate-500",
        )}
      />
    </div>
  );
}

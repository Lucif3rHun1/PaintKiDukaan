import { Minus, Plus } from "lucide-react";

import { cn } from "./cn";

export interface QtyInputProps {
  value: number;
  onChange: (n: number) => void;
  step?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}

export function QtyInput({
  value,
  onChange,
  step = 1,
  min = 0,
  max,
  disabled = false,
  className,
  ariaLabel = "Quantity",
}: QtyInputProps) {
  const ceiling = max ?? Number.POSITIVE_INFINITY;
  const dec = () => onChange(Math.max(min, round(value - step, step)));
  const inc = () => onChange(Math.min(ceiling, round(value + step, step)));

  return (
    <div className={cn("inline-flex items-center gap-1", className)}>
      <button
        type="button"
        onClick={dec}
        disabled={disabled || value <= min}
        aria-label="Decrease"
        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Minus className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={inc}
        disabled={disabled || value >= ceiling}
        aria-label="Increase"
        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <input
        type="number"
        inputMode="decimal"
        value={Number.isFinite(value) ? value : ""}
        onChange={(event) => {
          const raw = event.target.value;
          if (raw === "") {
            onChange(min);
            return;
          }
          const n = Number(raw);
          if (!Number.isFinite(n)) return;
          const clamped = Math.min(ceiling, Math.max(min, n));
          onChange(clamped);
        }}
        onBlur={(event) => {
          const n = Number(event.target.value);
          if (!Number.isFinite(n)) {
            onChange(min);
          } else {
            onChange(Math.min(ceiling, Math.max(min, n)));
          }
        }}
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        aria-label={ariaLabel}
        className="h-10 w-16 rounded border border-border bg-background text-center text-sm tabular-nums outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
      />
    </div>
  );
}

// ponytail: rounds to the step's decimal precision so decimal qty values like
// 0.5 don't accumulate floating-point drift on repeated +/−. Add per-line
// precision when qty units demand it.
function round(n: number, step: number): number {
  if (!Number.isFinite(step) || step <= 0) return n;
  const decimals = (step.toString().split(".")[1] ?? "").length;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

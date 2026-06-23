import { useCallback, useState } from "react";

export interface NumpadProps {
  /** Current value as a string of digits, optional decimal point. */
  value: string;
  onChange: (v: string) => void;
  /** Allow decimal input. Defaults to false. */
  allowDecimal?: boolean;
  /** Maximum number of digits after the decimal point. */
  decimals?: number;
  className?: string;
}

const KEYS: ReadonlyArray<{ label: string; value: string } | { kind: "back" } | { kind: "clear" }> = [
  { label: "1", value: "1" },
  { label: "2", value: "2" },
  { label: "3", value: "3" },
  { label: "4", value: "4" },
  { label: "5", value: "5" },
  { label: "6", value: "6" },
  { label: "7", value: "7" },
  { label: "8", value: "8" },
  { label: "9", value: "9" },
  { label: "00", value: "00" },
  { label: "0", value: "0" },
  { label: ".", value: "." },
  { kind: "back" },
  { label: "C", kind: "clear" as never },
] as const;

/**
 * Touch-friendly numpad for amount entry. Auto-formats on display only;
 * paise storage lives in the caller. Decimal rounding: none.
 */
export function Numpad({
  value,
  onChange,
  allowDecimal = false,
  decimals = 2,
  className,
}: NumpadProps) {
  const [internal, setInternal] = useState(value);

  const commit = useCallback(
    (next: string) => {
      setInternal(next);
      onChange(next);
    },
    [onChange],
  );

  const press = (k: (typeof KEYS)[number]) => {
    if ("kind" in k && k.kind === "back") {
      commit(internal.slice(0, -1));
      return;
    }
    if ("kind" in k && k.kind === "clear") {
      commit("");
      return;
    }
    if ("value" in k) {
      const ch = k.value;
      if (ch === ".") {
        if (!allowDecimal) return;
        if (internal.includes(".")) return;
        commit(internal === "" ? "0." : `${internal}.`);
        return;
      }
      // Split integer / fraction
      if (internal.includes(".")) {
        const [int, frac] = internal.split(".") as [string, string];
        if (frac.length >= decimals) return;
        commit(`${int}.${frac}${ch}`);
      } else {
        // Leading zeros: "00" before another digit collapses to "0"
        const next = internal === "0" && ch !== "00" ? ch : `${internal}${ch}`;
        commit(next);
      }
    }
  };

  return (
    <div className={className}>
      <div className="rounded-md border border-border bg-card p-3 text-right text-2xl tabular-nums">
        {internal || "0"}
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        {KEYS.map((k, i) => {
          const label = "label" in k ? k.label : "kind" in k && k.kind === "back" ? "⌫" : "C";
          const action = () => press(k);
          return (
            <button
              key={i}
              type="button"
              onClick={action}
              className="h-14 rounded-md bg-muted text-lg font-medium hover:bg-muted active:bg-muted"
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

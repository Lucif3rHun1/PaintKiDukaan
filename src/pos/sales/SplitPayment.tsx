import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { Button, MoneyInput } from "../../components/ui";
import type { PaymentMode, PaymentSplit } from "../types";

interface Props {
  total: number;
  splits: PaymentSplit[];
  onChange: (splits: PaymentSplit[]) => void;
}

type QuickPaymentMode = Extract<PaymentMode, "cash" | "upi" | "bank">;

const PAYMENT_MODE_BUTTONS: readonly {
  readonly value: QuickPaymentMode;
  readonly label: string;
}[] = [
  { value: "cash", label: "Cash" },
  { value: "upi", label: "UPI" },
  { value: "bank", label: "Bank" },
];

const PAYMENT_MODE_LABELS: Record<PaymentMode, string> = {
  cash: "Cash",
  upi: "UPI",
  card: "Card",
  bank: "Bank",
  cheque: "Cheque",
};

export function SplitPayment({ total, splits, onChange }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const pendingFocusIndex = useRef<number | null>(null);
  const initializedDefaultSplit = useRef(false);

  useEffect(() => {
    if (!initializedDefaultSplit.current) {
      initializedDefaultSplit.current = true;
      if (total > 0 && splits.length === 0) {
        onChange([{ mode: "cash", amount: total }]);
      }
      return;
    }

    if (
      splits.length === 1 &&
      splits[0]?.mode === "cash" &&
      splits[0].amount !== total
    ) {
      onChange([{ ...splits[0], amount: total }]);
    }
  }, [onChange, splits, total]);

  useEffect(() => {
    const index = pendingFocusIndex.current;
    if (index === null) return;
    focusAmountInput(index);
    pendingFocusIndex.current = null;
  }, [splits.length]);

  function focusAmountInput(index: number) {
    const input = rootRef.current?.querySelectorAll<HTMLInputElement>(
      "[data-payment-amount] input",
    )[index];
    input?.focus();
    input?.select();
  }

  function addOrFocusSplit(mode: QuickPaymentMode) {
    const existingIndex = splits.findIndex((split) => split.mode === mode);
    if (existingIndex >= 0) {
      focusAmountInput(existingIndex);
      return;
    }

    pendingFocusIndex.current = splits.length;
    // First split gets full amount; subsequent splits start empty.
    const amount = splits.length === 0 ? total : 0;
    onChange([...splits, { mode, amount }]);
  }

  function handleChange(index: number, patch: Partial<PaymentSplit>) {
    const next = splits.map((s, i) => (i === index ? { ...s, ...patch } : s));
    // First split is the running remainder — re-fill it whenever any
    // later split changes. Editing the first split itself is a direct commit.
    if (next.length > 1 && index !== 0 && patch.amount !== undefined) {
      const others = next
        .slice(1)
        .reduce((sum, s) => sum + s.amount, 0);
      next[0] = {
        ...next[0],
        amount: Math.max(0, total - others),
      };
    }
    onChange(next);
  }

  function removeSplit(index: number) {
    onChange(splits.filter((_, i) => i !== index));
  }

  return (
    <div ref={rootRef} className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-foreground">Payments</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {PAYMENT_MODE_BUTTONS.map((mode) => (
          <Button
            key={mode.value}
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed={splits.some((split) => split.mode === mode.value)}
            className="rounded-full border border-border bg-background px-3"
            onClick={() => addOrFocusSplit(mode.value)}
          >
            {mode.label}
          </Button>
        ))}
      </div>

      {splits.map((split, index) => (
        <div
          key={index}
          className="grid grid-cols-[auto_9rem_auto] items-center gap-2"
        >
          <span className="inline-flex items-center rounded-full border border-border bg-muted/50 px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
            {PAYMENT_MODE_LABELS[split.mode]}
          </span>
          <div data-payment-amount>
            <MoneyInput
              value={split.amount}
              onChange={(amount) => handleChange(index, { amount })}
              min={0}
            />
          </div>
          <button
            type="button"
            onClick={() => removeSplit(index)}
            aria-label="Remove payment"
            className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

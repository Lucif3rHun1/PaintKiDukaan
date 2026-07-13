import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { Button, MoneyInput } from "../../components/ui";
import type { PaymentMode, PaymentSplit } from "../types";
import { getPref, setPref } from "../../lib/storage";

interface Props {
  total: number;
  splits: PaymentSplit[];
  onChange: (splits: PaymentSplit[]) => void;
  /**
   * When true, a "Balance" tender button appears. Settles against the
   * customer's outstanding ledger via customer_payments instead of paying
   * out cash. Only meaningful when the linked sale has a customer
   * (walk-in sales have no balance to settle against).
   */
  balanceTenderAvailable?: boolean;
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
  balance: "Balance",
};

export function SplitPayment({ total, splits, onChange, balanceTenderAvailable }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const pendingFocusIndex = useRef<number | null>(null);
  const initializedDefaultSplit = useRef(false);

  const prevTotal = useRef(total);
  useEffect(() => {
    if (!initializedDefaultSplit.current) {
      initializedDefaultSplit.current = true;
      if (total > 0 && splits.length === 0) {
        const savedMode = getPref<QuickPaymentMode>("sale:lastPaymentMode", "cash");
        onChange([{ mode: savedMode, amount: total }]);
      }
    } else if (
      prevTotal.current !== total &&
      splits.length === 1 &&
      splits[0]?.mode === "cash"
    ) {
      onChange([{ ...splits[0], amount: total }]);
    }
    prevTotal.current = total;
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

  function addOrFocusSplit(mode: QuickPaymentMode | "balance") {
    setPref("sale:lastPaymentMode", mode);
    const existingIndex = splits.findIndex((split) => split.mode === mode);
    if (existingIndex >= 0) {
      focusAmountInput(existingIndex);
      return;
    }

    const currentTotal = splits.reduce((sum, s) => sum + s.amount, 0);
    if (currentTotal >= total && total > 0) return;

    pendingFocusIndex.current = splits.length;
    const remaining = Math.max(0, total - currentTotal);
    const amount = splits.length === 0 ? total : remaining;
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
    // M3: Clamp first split so total doesn't exceed bill total
    if (index === 0 && patch.amount !== undefined) {
      const othersSum = next.slice(1).reduce((sum, s) => sum + s.amount, 0);
      next[0] = { ...next[0], amount: Math.min(next[0].amount, Math.max(0, total - othersSum)) };
    }
    onChange(next);
  }

  function removeSplit(index: number) {
    const remaining = splits.filter((_, i) => i !== index);
    if (remaining.length === 1 && total > 0) {
      remaining[0] = { ...remaining[0], amount: total };
    } else if (remaining.length > 1) {
      const othersSum = remaining.slice(1).reduce((sum, s) => sum + s.amount, 0);
      remaining[0] = { ...remaining[0], amount: Math.max(0, total - othersSum) };
    }
    onChange(remaining);
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
        {balanceTenderAvailable && (
          <Button
            key="balance"
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed={splits.some((split) => split.mode === "balance")}
            className="rounded-full border border-info/40 bg-info/10 px-3 text-info"
            onClick={() => addOrFocusSplit("balance")}
            title="Settles against the customer's outstanding ledger instead of paying out cash"
          >
            Balance
          </Button>
        )}
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
          <Button
            variant="ghost"
            size="sm"
            icon={X}
            type="button"
            onClick={() => removeSplit(index)}
            aria-label="Remove payment"
            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          />
        </div>
      ))}
    </div>
  );
}

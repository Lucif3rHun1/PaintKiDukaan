import { Plus, X } from "lucide-react";
import { Button, MoneyInput, Select } from "../../components/ui";
import type { PaymentMode, PaymentSplit } from "../types";

interface Props {
  total: number;
  splits: PaymentSplit[];
  onChange: (splits: PaymentSplit[]) => void;
}

const MODE_OPTIONS = [
  { value: "cash", label: "Cash" },
  { value: "upi", label: "UPI" },
  { value: "card", label: "Card" },
  { value: "bank", label: "Bank" },
  { value: "cheque", label: "Cheque" },
] as const;

export function SplitPayment({ total, splits, onChange }: Props) {
  function addSplit() {
    const defaultMode = splits.length === 0 ? "cash" : "upi";
    onChange([...splits, { mode: defaultMode, amount: 0 }]);
  }

  function handleChange(index: number, patch: Partial<PaymentSplit>) {
    const next = splits.map((s, i) => (i === index ? { ...s, ...patch } : s));
    // Last split acts as the running remainder — re-fill it whenever an
    // earlier split changes. Editing the last split itself is a direct commit.
    if (
      next.length > 1 &&
      index !== next.length - 1 &&
      patch.amount !== undefined
    ) {
      const others = next
        .slice(0, -1)
        .reduce((sum, s) => sum + s.amount, 0);
      next[next.length - 1] = {
        ...next[next.length - 1],
        amount: Math.max(0, total - others),
      };
    }
    onChange(next);
  }

  function removeSplit(index: number) {
    onChange(splits.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-foreground">Payments</p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          icon={Plus}
          onClick={addSplit}
        >
          Add
        </Button>
      </div>

      {splits.map((split, index) => (
        <div
          key={index}
          className="grid grid-cols-[7rem_minmax(0,1fr)_2.25rem] items-center gap-2"
        >
          <Select
            value={split.mode}
            onChange={(e) =>
              handleChange(index, { mode: e.target.value as PaymentMode })
            }
            options={MODE_OPTIONS as unknown as { value: string; label: string }[]}
            size="md"
            aria-label="Payment mode"
          />
          <MoneyInput
            value={split.amount}
            onChange={(amount) => handleChange(index, { amount })}
            min={0}
          />
          <button
            type="button"
            onClick={() => removeSplit(index)}
            aria-label="Remove payment"
            className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
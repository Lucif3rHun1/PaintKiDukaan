// @ts-nocheck
import { Plus, X } from "lucide-react";
import { Button, MoneyInput } from "../../components/ui";
import type { PaymentMode, PaymentSplit } from "../types";

interface Props {
  total: number;
  splits: PaymentSplit[];
  onChange: (splits: PaymentSplit[]) => void;
}

const MODES: PaymentMode[] = ["cash", "upi", "card", "bank", "cheque"];

export function SplitPayment({ total, splits, onChange }: Props) {
  const paidAmount = splits.reduce((sum, s) => sum + s.amount, 0);
  const remaining = Math.max(0, total - paidAmount);

  function addSplit() {
    const defaultMode = splits.length === 0 ? "cash" : "upi";
    onChange([...splits, { mode: defaultMode, amount: remaining }]);
  }

  function updateSplit(index: number, patch: Partial<PaymentSplit>) {
    onChange(splits.map((s, i) => (i === index ? { ...s, ...patch } : s)));
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
          disabled={remaining === 0}
        >
          Add
        </Button>
      </div>

      {splits.map((split, index) => (
        <div key={index} className="flex items-center gap-2">
          <select
            value={split.mode}
            onChange={(e) =>
              updateSplit(index, { mode: e.target.value as PaymentMode })
            }
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          >
            {MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <MoneyInput
            value={split.amount}
            onChange={(amount) => updateSplit(index, { amount })}
            min={0}
            className="flex-1"
          />
          <button
            type="button"
            onClick={() => removeSplit(index)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

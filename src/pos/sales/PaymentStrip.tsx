import { MoneyStatic, cn } from "../../components/ui";
import { SplitPayment } from "./SplitPayment";
import { formatRupeesFromPaise } from "../../lib/money";
import type { PaymentSplit } from "../types";

interface PaymentStripProps {
  total: number;
  splits: PaymentSplit[];
  onChange: (splits: PaymentSplit[]) => void;
  paid: number;
  balance: number;
}

export function PaymentStrip({
  total,
  splits,
  onChange,
  paid,
  balance,
}: PaymentStripProps) {
  return (
    <>
      <SplitPayment
        total={total}
        splits={splits}
        onChange={onChange}
      />
      <div className="grid grid-cols-[1fr_8rem] items-center gap-3 text-xs">
        <span className="text-muted-foreground">Paid</span>
        <MoneyStatic paise={paid} tone="muted" />
      </div>
      <div className="grid grid-cols-[1fr_8rem] items-center gap-3 text-xs">
        <span
          className={cn(
            balance > 0 ? "text-destructive" : "text-success",
          )}
        >
          {balance > 0 ? "Balance due" : "Fully paid"}
        </span>
        <MoneyStatic
          paise={Math.abs(balance)}
          tone={balance > 0 ? "destructive" : "success"}
        />
      </div>
    </>
  );
}

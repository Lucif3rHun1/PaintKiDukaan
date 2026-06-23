/**
 * KhataRecord — chronological list of sales and payments for a customer.
 * Slice C will own the actual sales/payments write paths; this view is
 * read-only and pulls aggregated numbers via the `customer_outstanding`
 * command. It is intentionally a thin ledger: nothing more than a sum
 * line per (sale|payment) the day Slice C lands. For now it surfaces a
 * placeholder so the UI is testable.
 */
import { useEffect, useState } from "react";
import { customerOutstanding } from "./api";
import { formatRupeesFromPaise } from "../../lib/money";
import { formatDateForDisplay } from "../../lib/date";
import type { CustomerOutstanding } from "../types";

interface Props {
  customerId: number;
}

interface Row {
  date: string;
  kind: "sale" | "payment";
  amount: number;
  ref: string;
}

export function KhataRecord({ customerId }: Props) {
  const [data, setData] = useState<CustomerOutstanding | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    customerOutstanding(customerId)
      .then((d) => setData(d ?? null))
      .catch((e) => setError(e.message ?? "Failed"));
  }, [customerId]);

  // Slice C will write sales + customer_payments rows; B only reads the
  // aggregate here. The detailed per-row ledger is wired in Slice C.
  const placeholder: Row[] = data
    ? [
        {
          date: "—",
          kind: "sale",
          amount: data.total_sales,
          ref: "(aggregated across all final bills)",
        },
        {
          date: "—",
          kind: "payment",
          amount: -data.total_payments,
          ref: "(aggregated payments)",
        },
      ]
    : [];

  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-foreground">Khata</h3>
      {error && (
        <p className="rounded bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th className="py-1">Date</th>
            <th>Type</th>
            <th>Ref</th>
            <th className="text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {placeholder.map((r, idx) => (
            <tr key={idx} className="border-b border-border">
              <td className="py-1 font-mono text-xs">{r.date === "—" ? r.date : formatDateForDisplay(r.date)}</td>
              <td>{r.kind}</td>
              <td>{r.ref}</td>
              <td className="text-right">{formatRupeesFromPaise(r.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted-foreground">
        Detailed per-transaction ledger is wired in Slice C.
      </p>
    </div>
  );
}

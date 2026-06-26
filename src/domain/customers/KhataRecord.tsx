/**
 * KhataRecord — chronological list of sales and payments for a customer.
 * Uses canonical DataTable primitive.
 */
import { useEffect, useState } from "react";
import { DataTable, Money } from "../../components/ui";
import type { ColumnDef } from "../../components/ui";
import { extractError } from "../../lib/extractError";
import { formatDateForDisplay } from "../../lib/date";
import { customerOutstanding } from "./api";
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
      .catch((e) => setError(extractError(e)));
  }, [customerId]);

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
          amount: data.total_payments,
          ref: "(aggregated payments)",
        },
      ]
    : [];

  const columns: ColumnDef<Row>[] = [
    {
      header: "Date",
      cell: (r) => (
        <span className="font-mono text-xs text-foreground">
          {r.date === "—" ? r.date : formatDateForDisplay(r.date)}
        </span>
      ),
    },
    {
      header: "Type",
      cell: (r) => <span className="text-foreground">{r.kind}</span>,
    },
    {
      header: "Ref",
      cell: (r) => <span className="text-muted-foreground">{r.ref}</span>,
    },
    {
      header: "Amount",
      align: "right",
      cell: (r) => <Money paise={r.amount} />,
    },
  ];

  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-foreground">Khata</h3>
      {error && (
        <p className="rounded bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <DataTable
        data={placeholder}
        columns={columns}
        keyExtractor={(_, idx) => idx}
      />
      <p className="mt-2 text-xs text-muted-foreground">
        Detailed per-transaction ledger is wired in Slice C.
      </p>
    </div>
  );
}

import { Badge, DataTable, EmptyState, Money } from "../../components/ui";
import type { ColumnDef } from "../../components/ui";
import { formatDateForDisplay } from "../../lib/date";
import type { CustomerLedgerTransaction } from "../types";

const columns: ColumnDef<CustomerLedgerTransaction>[] = [
  {
    header: "Date",
    cell: (row) => (
      <span className="font-mono text-xs text-muted-foreground">
        {formatDateForDisplay(row.date)}
      </span>
    ),
  },
  {
    header: "Type",
    cell: (row) => (
      <Badge variant={row.kind === "sale" ? "warning" : "success"} size="sm">
        {row.kind === "sale" ? "Sale" : "Payment"}
      </Badge>
    ),
  },
  {
    header: "Ref",
    cell: (row) => (
      <span className="text-xs text-muted-foreground">
        {row.ref_no ?? "—"}
      </span>
    ),
  },
  {
    header: "Description",
    cell: (row) => (
      <span className="text-xs text-muted-foreground">
        {row.description ?? "—"}
      </span>
    ),
  },
  {
    header: "Debit",
    align: "right",
    cell: (row) =>
      row.debit_paise > 0 ? <Money paise={row.debit_paise} /> : "—",
  },
  {
    header: "Credit",
    align: "right",
    cell: (row) =>
      row.credit_paise > 0 ? <Money paise={row.credit_paise} /> : "—",
  },
  {
    header: "Balance",
    align: "right",
    cell: (row) => <Money paise={row.balance_paise} />,
  },
];

export function LedgerTable({ rows }: { rows: CustomerLedgerTransaction[] }) {
  return (
    <DataTable
      data={rows}
      columns={columns}
      keyExtractor={(_, idx) => idx}
      emptyState={
        <EmptyState title="No activity yet" description="Sales, payments, and credit invoices will appear here." />
      }
      className="surface-sunken shadow-none"
    />
  );
}

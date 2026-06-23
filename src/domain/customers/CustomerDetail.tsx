/**
 * CustomerDetail — read view with outstanding balance.
 */
import { useEffect, useState } from "react";
import { customerOutstanding } from "./api";
import { formatRupeesFromPaise } from "../../lib/money";
import type { Customer, CustomerOutstanding } from "../types";
import { KhataRecord } from "./KhataRecord";

interface Props {
  customer: Customer;
  onEdit?: () => void;
  onRecordPayment?: () => void;
}

export function CustomerDetail({ customer, onEdit, onRecordPayment }: Props) {
  const [outstanding, setOutstanding] = useState<CustomerOutstanding | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    customerOutstanding(customer.id)
      .then((d) => setOutstanding(d ?? null))
      .catch((e) => setError(e.message ?? "Failed"));
  }, [customer.id]);

  return (
    <div>
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h2 className="text-xl font-semibold">{customer.name}</h2>
          <p className="font-mono text-sm text-muted-foreground">{customer.phone}</p>
          {customer.is_flagged && (
            <span className="mt-1 inline-block rounded bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
              flagged
            </span>
          )}
        </div>
        <div className="flex gap-2">
          {onEdit && (
            <button
              onClick={onEdit}
              className="rounded border border-border px-3 py-1 text-sm text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            >
              Edit
            </button>
          )}
          {onRecordPayment && (
            <button
              onClick={onRecordPayment}
              className="rounded bg-primary px-3 py-1 text-sm font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            >
              Record payment
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className="mb-3 rounded bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <dl className="mb-4 grid grid-cols-3 gap-3 text-sm">
        <Row label="Type" value={customer.type_name ?? "—"} />
        <Row
          label="Credit limit"
          value={
            customer.credit_limit != null
            ? formatRupeesFromPaise(customer.credit_limit)
            : "—"
          }
        />
        <Row label="Opening" value={formatRupeesFromPaise(customer.opening_balance_paise)} />
        <Row
          label="Total sales"
          value={outstanding ? formatRupeesFromPaise(outstanding.total_sales) : "…"}
        />
        <Row
          label="Total paid (in sales)"
          value={outstanding ? formatRupeesFromPaise(outstanding.total_paid) : "…"}
        />
        <Row
          label="Customer payments"
          value={outstanding ? formatRupeesFromPaise(outstanding.total_payments) : "…"}
        />
      </dl>

      <div className="mb-4 rounded-lg border border-border bg-muted p-4">
        <p className="text-xs uppercase text-muted-foreground">Outstanding</p>
        <p className="text-2xl font-semibold tabular-nums text-foreground">
          {outstanding ? formatRupeesFromPaise(outstanding.outstanding) : "…"}
        </p>
      </div>

      {customer.notes && (
        <div className="mb-4">
          <p className="text-xs uppercase text-muted-foreground">Notes</p>
          <p className="whitespace-pre-wrap text-sm text-foreground">
            {customer.notes}
          </p>
        </div>
      )}

      <KhataRecord customerId={customer.id} />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase text-muted-foreground">{label}</dt>
      <dd className="tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

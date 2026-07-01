/**
 * CustomerDetail — read view with outstanding balance.
 */
import { useQuery } from "@tanstack/react-query";
import { customerOutstanding } from "./api";
import { extractError } from "../../lib/extractError";
import { formatRupeesFromPaise } from "../../lib/money";
import { toTitleCase } from "../../lib/format/titleCase";
import type { Customer } from "../types";
import { CustomerLedgerView } from "./CustomerLedgerView";
import { Button } from "../../components/ui/Button";
import { Alert } from "../../components/ui";

interface Props {
  customer: Customer;
  onEdit?: () => void;
  onRecordPayment?: () => void;
}

export function CustomerDetail({ customer, onEdit, onRecordPayment }: Props) {
  const { data: outstanding, error: outstandingErr } = useQuery({
    queryKey: ["customer-outstanding", customer.id],
    queryFn: () => customerOutstanding(customer.id),
  });
  const error = outstandingErr ? extractError(outstandingErr) : null;

  return (
    <div>
      <div className="mb-4 flex items-start justify-between pr-12">
        <div>
          <h2 className="text-xl font-semibold">{toTitleCase(customer.name)}</h2>
          <p className="font-mono text-sm text-muted-foreground">{customer.phone}</p>
          {customer.is_flagged && (
            <span className="mt-1 inline-block rounded bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
              flagged
            </span>
          )}
        </div>
        <div className="flex gap-2">
          {onEdit && (
            <Button variant="secondary" size="sm" onClick={onEdit}>
              Edit
            </Button>
          )}
          {onRecordPayment && (
            <Button variant="primary" size="sm" onClick={onRecordPayment}>
              Record payment
            </Button>
          )}
        </div>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-3">{error}</Alert>
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

      <CustomerLedgerView customer={customer} />
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

/**
 * CustomerDetail — read view with outstanding balance.
 */
import { useQuery } from "@tanstack/react-query";
import { customerOutstanding } from "./api";
import { extractError } from "../../lib/extractError";
import { toTitleCase } from "../../lib/format/titleCase";
import { useState, type ReactNode } from "react";
import type { Customer } from "../types";
import { CustomerCreditInvoiceForm, CustomerLedgerView } from "./CustomerLedgerView";
import { Button } from "../../components/ui/Button";
import { Alert, Badge, Card, MoneyStatic, Skeleton } from "../../components/ui";

interface Props {
  customer: Customer;
  onEdit?: () => void;
  onRecordPayment?: () => void;
}

export function CustomerDetail({ customer, onEdit, onRecordPayment }: Props) {
  const [creatingCreditInvoice, setCreatingCreditInvoice] = useState(false);
  const { data: outstanding, error: outstandingErr } = useQuery({
    queryKey: ["customer-outstanding", customer.id],
    queryFn: () => customerOutstanding(customer.id),
  });
  const error = outstandingErr ? extractError(outstandingErr) : null;

  if (creatingCreditInvoice) {
    return (
      <CustomerCreditInvoiceForm
        customer={customer}
        onSaved={() => setCreatingCreditInvoice(false)}
        onCancel={() => setCreatingCreditInvoice(false)}
      />
    );
  }

  return (
    <Card depth="flat" className="gap-0 p-4">
      <div className="mb-4 flex items-start justify-between pr-12">
        <div>
          <h2 className="text-xl font-semibold">{toTitleCase(customer.name)}</h2>
          <p className="font-mono text-sm text-muted-foreground">{customer.phone}</p>
          {customer.is_flagged && (
            <Badge variant="warning" size="sm" className="mt-1">Flagged</Badge>
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
            ? <MoneyStatic paise={customer.credit_limit} className="justify-start" />
            : "—"
          }
        />
        <Row label="Opening" value={<MoneyStatic paise={customer.opening_balance_paise} className="justify-start" />} />
        <Row
          label="Total sales"
          value={outstanding ? <MoneyStatic paise={outstanding.total_sales} className="justify-start" /> : <Skeleton className="w-20" />}
        />
        <Row
          label="Total paid (in sales)"
          value={outstanding ? <MoneyStatic paise={outstanding.total_paid} className="justify-start" /> : <Skeleton className="w-20" />}
        />
        <Row
          label="Customer payments"
          value={outstanding ? <MoneyStatic paise={outstanding.total_payments} className="justify-start" /> : <Skeleton className="w-20" />}
        />
      </dl>

      <Card depth="raised" className="mb-4 gap-1 p-4">
        <p className="text-xs uppercase text-muted-foreground">Outstanding</p>
        {outstanding ? (
          <MoneyStatic paise={outstanding.outstanding} className="justify-start text-2xl font-semibold" />
        ) : (
          <Skeleton className="h-7 w-28" />
        )}
      </Card>

      {customer.notes && (
        <div className="mb-4">
          <p className="text-xs uppercase text-muted-foreground">Notes</p>
          <p className="whitespace-pre-wrap text-sm text-foreground">
            {customer.notes}
          </p>
        </div>
      )}

      <CustomerLedgerView
        customer={customer}
        onCreateCreditInvoice={() => setCreatingCreditInvoice(true)}
      />
    </Card>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase text-muted-foreground">{label}</dt>
      <dd className="tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

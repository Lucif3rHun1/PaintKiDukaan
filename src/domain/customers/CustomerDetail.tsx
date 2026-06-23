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
      .then(setOutstanding)
      .catch((e) => setError(e.message ?? "Failed"));
  }, [customer.id]);

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h2 className="text-xl font-semibold">{customer.name}</h2>
          <p className="font-mono text-sm text-slate-500">{customer.phone}</p>
          {customer.is_flagged && (
            <span className="mt-1 inline-block rounded bg-red-100 px-2 py-0.5 text-xs text-red-700">
              flagged
            </span>
          )}
        </div>
        <div className="flex gap-2">
          {onEdit && (
            <button
              onClick={onEdit}
              className="rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50"
            >
              Edit
            </button>
          )}
          {onRecordPayment && (
            <button
              onClick={onRecordPayment}
              className="rounded bg-sky-600 px-3 py-1 text-sm font-medium text-white hover:bg-sky-700"
            >
              Record payment
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
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

      <div className="mb-4 rounded border border-slate-200 bg-slate-50 p-4">
        <p className="text-xs uppercase text-slate-500">Outstanding</p>
        <p className="text-2xl font-semibold text-slate-800">
          {outstanding ? formatRupeesFromPaise(outstanding.outstanding) : "…"}
        </p>
      </div>

      {customer.notes && (
        <div className="mb-4">
          <p className="text-xs uppercase text-slate-500">Notes</p>
          <p className="whitespace-pre-wrap text-sm text-slate-700">
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
      <dt className="text-xs uppercase text-slate-500">{label}</dt>
      <dd className="text-slate-800">{value}</dd>
    </div>
  );
}

import { useEffect, useState, type ReactNode } from "react";
import { Money, Button } from "../../components/ui";
import { vendorOutstanding } from "./api";
import type { Vendor, VendorOutstanding } from "../types";

interface Props {
  vendor: Vendor;
  onEdit?: (v: Vendor) => void;
  onRecordPayment?: (v: Vendor) => void;
}

export function VendorDetail({ vendor, onEdit, onRecordPayment }: Props) {
  const [outstanding, setOutstanding] = useState<VendorOutstanding | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    vendorOutstanding(vendor.id)
      .then((d) => setOutstanding(d ?? null))
      .catch((e) => setError(e.message ?? "Failed"));
  }, [vendor.id]);

  return (
    <div>
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h2 className="text-xl font-semibold">{vendor.name}</h2>
          <p className="font-mono text-sm text-muted-foreground">
            {vendor.phone ?? "—"}
          </p>
          {vendor.contact_person && (
            <p className="text-sm text-muted-foreground">
              Contact: {vendor.contact_person}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          {onEdit && (
            <Button variant="secondary" size="sm" onClick={() => onEdit(vendor)}>
              Edit
            </Button>
          )}
          {onRecordPayment && (
            <Button size="sm" onClick={() => onRecordPayment(vendor)}>
              Record payment
            </Button>
          )}
        </div>
      </div>

      {error && (
        <p className="mb-3 rounded bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <dl className="mb-4 grid grid-cols-3 gap-3 text-sm">
        <Row label="Opening" value={<Money paise={(vendor.opening_balance ?? 0) * 100} />} />
        <Row label="Total purchases" value={outstanding ? <Money paise={outstanding.total_purchases} /> : "…"} />
        <Row label="Total payments" value={outstanding ? <Money paise={outstanding.total_payments} /> : "…"} />
      </dl>

      <div className="mb-4 rounded-lg border border-border bg-muted p-4">
        <p className="text-xs uppercase text-muted-foreground">Outstanding</p>
          <p className="text-2xl font-semibold text-foreground">
          {outstanding ? <Money paise={outstanding.outstanding} /> : "…"}
        </p>
      </div>

      {vendor.notes && (
        <div className="mb-4">
          <p className="text-xs uppercase text-muted-foreground">Notes</p>
          <p className="whitespace-pre-wrap text-sm text-foreground">
            {vendor.notes}
          </p>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  );
}

import { useEffect, useState, type ReactNode } from "react";
import { Alert, Money, Button } from "../../components/ui";
import { extractError } from "../../lib/extractError";
import { toTitleCase } from "../../lib/format/titleCase";
import { vendorOutstanding } from "./api";
import { VendorForm } from "./VendorForm";
import { VendorPaymentForm } from "./VendorPaymentForm";
import type { Vendor, VendorOutstanding } from "../types";

interface Props {
  vendor: Vendor;
  onEdit?: (v: Vendor) => void;
  onRecordPayment?: (v: Vendor) => void;
}

export function VendorDetail({ vendor, onEdit, onRecordPayment }: Props) {
  const [vendorData, setVendorData] = useState(vendor);
  const [outstanding, setOutstanding] = useState<VendorOutstanding | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(false);

  useEffect(() => {
    setVendorData(vendor);
  }, [vendor]);

  useEffect(() => {
    setError(null);
    vendorOutstanding(vendorData.id)
      .then((d) => setOutstanding(d ?? null))
      .catch((e) => setError(extractError(e)));
  }, [vendorData.id]);

  if (editing) {
    return (
      <VendorForm
        mode="edit"
        initial={vendorData}
        onSaved={(v) => {
          setVendorData(v);
          setEditing(false);
          setError(null);
          vendorOutstanding(v.id)
            .then((d) => setOutstanding(d ?? null))
            .catch((e) => setError(extractError(e)));
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  if (paying) {
    return (
      <VendorPaymentForm
        vendor={vendorData}
        onSaved={(out) => {
          setOutstanding(out);
          setPaying(false);
        }}
        onCancel={() => setPaying(false)}
      />
    );
  }

  return (
    <div>
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h2 className="text-xl font-semibold">{toTitleCase(vendorData.name)}</h2>
          <p className="font-mono text-sm text-muted-foreground">
            {vendorData.phone ?? "—"}
          </p>
          {vendorData.contact_person && (
            <p className="text-sm text-muted-foreground">
              Contact: {vendorData.contact_person}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          {onEdit && (
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
          {onRecordPayment && (
            <Button size="sm" onClick={() => setPaying(true)}>
              Record payment
            </Button>
          )}
        </div>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-3">{error}</Alert>
      )}

      <dl className="mb-4 grid grid-cols-3 gap-3 text-sm">
        <Row label="Opening" value={<Money paise={(vendorData.opening_balance ?? 0) * 100} />} />
        <Row label="Total purchases" value={outstanding ? <Money paise={outstanding.total_purchases} /> : "…"} />
        <Row label="Total payments" value={outstanding ? <Money paise={outstanding.total_payments} /> : "…"} />
      </dl>

      <div className="mb-4 rounded-lg border border-border bg-muted p-4">
        <p className="text-xs uppercase text-muted-foreground">Outstanding</p>
          <p className="text-2xl font-semibold text-foreground">
          {outstanding ? <Money paise={outstanding.outstanding} /> : "…"}
        </p>
      </div>

      {vendorData.notes && (
        <div className="mb-4">
          <p className="text-xs uppercase text-muted-foreground">Notes</p>
          <p className="whitespace-pre-wrap text-sm text-foreground">
            {vendorData.notes}
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

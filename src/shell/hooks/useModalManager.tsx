import { useEffect, useState } from "react";
import { toast } from "@/lib/feedback/toast";
import { InlineDialog } from "@/components/ui/InlineDialog";
import { CustomerForm } from "@/domain/customers/CustomerForm";
import { CustomerDetail } from "@/domain/customers/CustomerDetail";
import { CustomerPaymentForm } from "@/domain/customers/CustomerPaymentForm";
import { VendorForm } from "@/domain/vendors/VendorForm";
import { VendorPaymentForm } from "@/domain/vendors/VendorPaymentForm";
import { VendorDetail } from "@/domain/vendors/VendorDetail";
import { listCustomerTypes } from "@/domain/customerTypes/api";
import { useSecurity } from "@/lib/security/state";
import type { Customer, CustomerType, Vendor } from "@/domain/types";

export function useModalManager() {
  const phase = useSecurity((s) => s.phase);

  /* ── Vendor modal state ───────────────────────────────── */
  const [vendorCreateOpen, setVendorCreateOpen] = useState(false);
  const [vendorEditTarget, setVendorEditTarget] = useState<Vendor | null>(null);
  const [vendorDetailTarget, setVendorDetailTarget] = useState<Vendor | null>(null);
  const [vendorPaymentTarget, setVendorPaymentTarget] = useState<Vendor | null>(null);

  /* ── Customer modal state ─────────────────────────────── */
  const [customerCreateOpen, setCustomerCreateOpen] = useState(false);
  const [customerEditTarget, setCustomerEditTarget] = useState<Customer | null>(null);
  const [customerDetailTarget, setCustomerDetailTarget] = useState<Customer | null>(null);
  const [customerPaymentTarget, setCustomerPaymentTarget] = useState<Customer | null>(null);
  const [customerTypes, setCustomerTypes] = useState<CustomerType[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  // Fetch customer types once the app is unlocked
  useEffect(() => {
    if (phase === "unlocked") {
      listCustomerTypes().then((d) => setCustomerTypes(d ?? [])).catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[App] failed to load customer types", e);
      });
    }
  }, [phase]);

  const modalJSX = (
    <>
      {/* ── Vendor modals ──────────────────────────────── */}
      <InlineDialog
        open={vendorCreateOpen}
        onClose={() => setVendorCreateOpen(false)}
        title="Add vendor"
      >
        <VendorForm
          mode="create"
          onSaved={(v) => { setVendorCreateOpen(false); setRefreshKey((k) => k + 1); setVendorDetailTarget(v); }}
          onCancel={() => setVendorCreateOpen(false)}
        />
      </InlineDialog>

      <InlineDialog
        open={!!vendorEditTarget}
        onClose={() => setVendorEditTarget(null)}
        title="Edit vendor"
      >
        {vendorEditTarget && (
          <VendorForm
            mode="edit"
            initial={vendorEditTarget}
            onSaved={(v) => { setVendorEditTarget(null); setRefreshKey((k) => k + 1); setVendorDetailTarget(v); }}
            onCancel={() => setVendorEditTarget(null)}
          />
        )}
      </InlineDialog>

      <InlineDialog
        open={!!vendorPaymentTarget}
        onClose={() => setVendorPaymentTarget(null)}
        title="Record Vendor payment"
      >
        {vendorPaymentTarget && (
          <VendorPaymentForm
            vendor={vendorPaymentTarget}
            onSaved={() => { setVendorPaymentTarget(null); setRefreshKey((k) => k + 1); }}
            onCancel={() => setVendorPaymentTarget(null)}
          />
        )}
      </InlineDialog>

      <InlineDialog
        open={!!vendorDetailTarget}
        onClose={() => setVendorDetailTarget(null)}
        title="Vendor details"
        size="lg"
      >
        {vendorDetailTarget && (
          <VendorDetail
            vendor={vendorDetailTarget}
            onEdit={(v) => { setVendorDetailTarget(null); setVendorEditTarget(v); }}
            onRecordPayment={(v) => { setVendorDetailTarget(null); setVendorPaymentTarget(v); }}
          />
        )}
      </InlineDialog>

      {/* ── Customer modals ────────────────────────────── */}
      <InlineDialog
        open={customerCreateOpen}
        onClose={() => setCustomerCreateOpen(false)}
        title="Add customer"
      >
        <CustomerForm
          mode="create"
          types={customerTypes}
          onSaved={() => { setCustomerCreateOpen(false); setRefreshKey((k) => k + 1); toast.success("Customer created"); }}
          onCancel={() => setCustomerCreateOpen(false)}
        />
      </InlineDialog>

      <InlineDialog
        open={!!customerEditTarget}
        onClose={() => setCustomerEditTarget(null)}
        title="Edit customer"
      >
        {customerEditTarget && (
          <CustomerForm
            mode="edit"
            initial={customerEditTarget}
            types={customerTypes}
            onSaved={(c) => { setCustomerEditTarget(null); setRefreshKey((k) => k + 1); }}
            onCancel={() => setCustomerEditTarget(null)}
          />
        )}
      </InlineDialog>

      <InlineDialog
        open={!!customerDetailTarget}
        onClose={() => setCustomerDetailTarget(null)}
        title="Customer details"
        size="lg"
      >
        {customerDetailTarget && (
          <CustomerDetail
            customer={customerDetailTarget}
            onEdit={() => { setCustomerDetailTarget(null); setCustomerEditTarget(customerDetailTarget); }}
            onRecordPayment={() => { setCustomerDetailTarget(null); setCustomerPaymentTarget(customerDetailTarget); }}
          />
        )}
      </InlineDialog>

      <InlineDialog
        open={!!customerPaymentTarget}
        onClose={() => setCustomerPaymentTarget(null)}
        title="Record Customer payment"
      >
        {customerPaymentTarget && (
          <CustomerPaymentForm
            customer={customerPaymentTarget}
            onSaved={() => { setCustomerPaymentTarget(null); setRefreshKey((k) => k + 1); }}
            onCancel={() => setCustomerPaymentTarget(null)}
          />
        )}
      </InlineDialog>
    </>
  );

  return {
    refreshKey,
    modalJSX,
    // Vendor callbacks for VendorList
    openVendorCreate: () => setVendorCreateOpen(true),
    openVendorDetail: (v: Vendor) => setVendorDetailTarget(v),
    openVendorPayment: (v: Vendor) => setVendorPaymentTarget(v),
    // Customer callbacks for CustomerList
    openCustomerCreate: () => setCustomerCreateOpen(true),
    openCustomerDetail: (c: Customer) => setCustomerDetailTarget(c),
    openCustomerPayment: (c: Customer) => setCustomerPaymentTarget(c),
  };
}

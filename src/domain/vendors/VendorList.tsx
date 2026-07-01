/**
 * VendorList — searchable list with outstanding + role-gated Pay action.
 * Renders via <DataList> server source (cmd_list_vendors_paged).
 */
import { useEffect, useMemo, useState } from "react";
import { Banknote, Phone, Truck } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { Button, DataList, EmptyState, Money } from '../../components/ui';
import type { ColumnDef } from "../../components/ui";
import { toast } from "../../lib/feedback/toast";
import { listVendorsPaged, listVendorMetrics } from "./api";
import { outstandingReport } from "../../pos/api";
import { type Vendor } from "../types";
import { extractError } from "../../lib/extractError";
import { useShortcut } from "../../lib/shortcuts";
import { useFocusShortcut } from "../../lib/shortcuts/useFocusShortcut";
import { toTitleCase } from "../../lib/format/titleCase";

interface Props {
  onSelect?: (v: Vendor) => void;
  onCreate?: () => void;
  onRecordPayment?: (v: Vendor) => void;
  refreshKey?: number;
  role: "owner" | "cashier" | "stocker";
}

const PAGE_SIZE = 25;

export function VendorList({
  onSelect,
  onCreate,
  onRecordPayment,
  refreshKey,
  role,
}: Props) {
  const [outstandings, setOutstandings] = useState<Record<number, number>>({});

  const vendorMetrics = useQuery({
    queryKey: ["list-metrics", "cmd_vendor_metrics"],
    queryFn: listVendorMetrics,
  });

  const serverSource = useMemo(() => ({
    endpoint: "cmd_list_vendors_paged",
    pageSize: PAGE_SIZE,
    initialSort: { field: "name", dir: "asc" as const },
    clientFn: listVendorsPaged,
  }), [refreshKey]);

  // Batch fetch outstanding report when total changes (so we have vendor IDs).
  const totalVendors = vendorMetrics.data?.total ?? 0;
  useEffect(() => {
    let cancelled = false;
    if (totalVendors === 0) {
      setOutstandings({});
      return;
    }
    outstandingReport()
      .then((report) => {
        if (cancelled) return;
        const map: Record<number, number> = {};
        for (const v of report.vendors) {
          map[v.vendor_id] = v.outstanding;
        }
        setOutstandings(map);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          toast.warning(extractError(e));
          setOutstandings({});
        }
      });
    return () => {
      cancelled = true;
    };
  }, [totalVendors]);

  function handlePay(v: Vendor) {
    if (onRecordPayment) {
      onRecordPayment(v);
      return;
    }
    toast.info(`No payment handler available for ${v.name}`);
  }

  const canCreate = onCreate && (role === "owner" || role === "stocker");
  const canPay = (role === "owner" || role === "stocker") && onRecordPayment;

  const columns = useMemo<ColumnDef<Vendor>[]>(() => {
    const cols: ColumnDef<Vendor>[] = [
      {
        id: "name",
        header: "Name",
        cell: (v) => (
          <span className="font-medium text-foreground">{toTitleCase(v.name)}</span>
        ),
        sortField: "name",
        sortable: true,
        searchable: true,
      },
      {
        id: "phone",
        header: "Phone",
        cell: (v) =>
          v.phone ? (
            <span className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
              <Phone className="h-3 w-3" />
              {v.phone}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
        sortField: "phone",
        sortable: true,
      },
      {
        id: "opening",
        header: "Opening",
        align: "right",
        cell: (v) => <Money paise={v.opening_balance ?? 0} muted />,
        sortField: "opening_balance_paise",
        sortable: true,
      },
      {
        id: "outstanding",
        header: "Outstanding",
        align: "right",
        cell: (v) =>
          outstandings[v.id] != null ? (
            <Money
              paise={outstandings[v.id]}
              negative={outstandings[v.id] < 0}
            />
          ) : (
            <span className="text-xs text-muted-foreground">…</span>
          ),
      },
    ];

    if (canPay) {
      cols.push({
        id: "action",
        header: "Action",
        align: "right",
        cell: (v) => (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            icon={Banknote}
            onClick={() => handlePay(v)}
          >
            Pay
          </Button>
        ),
      });
    }

    return cols;
  }, [canPay, outstandings]);

  const rowClassName = (v: Vendor) => (v.is_active ? "" : "opacity-60");

  useFocusShortcut({ key: "F2", selector: '[data-shortcut="search"]', description: "Focus search" });
  useShortcut({
    key: "F5",
    scope: "page",
    description: "Refresh list",
    onMatch: () => {
      void vendorMetrics.refetch();
    },
  });
  useShortcut({
    key: "F6",
    scope: "page",
    description: "New vendor",
    onMatch: () => {
      if (canCreate && onCreate) onCreate();
    },
  });

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-2xl font-semibold tracking-tight">Vendors</h2>
          <p className="text-sm text-muted-foreground">
            {vendorMetrics.data?.total ?? "—"} {(vendorMetrics.data?.total ?? 0) === 1 ? "vendor" : "vendors"}
          </p>
        </div>
        {canCreate ? (
          <Button
            type="button"
            variant="primary"
            size="md"
            icon={Truck}
            onClick={onCreate}
            shortcut="F6"
          >
            New Vendor
          </Button>
        ) : null}
      </header>

      <DataList
        source={serverSource}
        columns={columns}
        keyExtractor={(v) => v.id}
        searchPlaceholder="Search by name or phone…"
        emptyState={({ hasActiveFilter }) => (
          <EmptyState
            icon={Truck}
            title={hasActiveFilter ? "No matches" : "No vendors yet"}
            description={
              hasActiveFilter
                ? "Nothing matches your search. Try a different query."
                : "Add the first vendor to start receiving stock and tracking payables."
            }
            primary={
              canCreate ? (
                <Button type="button" onClick={onCreate} icon={Truck}>
                  Add Vendor
                </Button>
              ) : undefined
            }
          />
        )}
        onRowClick={onSelect ? (v) => onSelect(v) : undefined}
        rowClassName={rowClassName}
        height={520}
      />
    </div>
  );
}
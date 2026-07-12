/**
 * VendorList — searchable list with outstanding + role-gated Pay action.
 * Renders via <DataList> server source (cmd_list_vendors_paged).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, Banknote, Phone, Truck } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { ActionMenu, Button, DataList, EmptyState, Money } from '../../components/ui';
import type { ColumnDef } from "../../components/ui";
import { ConfirmDialog } from "../../shell/components/ConfirmDialog";
import { toast } from "../../lib/feedback/toast";
import { listVendorsPaged, listVendorMetrics, updateVendor } from "./api";
import { outstandingReport } from "../../pos/api";
import { type Vendor } from "../types";
import { extractError } from "../../lib/extractError";
import { useShortcut } from "../../lib/shortcuts";
import { useFocusShortcut } from "../../lib/shortcuts/useFocusShortcut";
import { toTitleCase } from "../../lib/format/titleCase";
import { Skeleton } from "boneyard-js/react";

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
  const canEdit = role === "owner";
  const queryClient = useQueryClient();
  const [archiveConfirmVendor, setArchiveConfirmVendor] = useState<Vendor | null>(null);

  const vendorMetrics = useQuery({
    queryKey: ["list-metrics", "cmd_vendor_metrics"],
    queryFn: listVendorMetrics,
  });

  const handleArchive = useCallback(async (vendor: Vendor) => {
    try {
      await updateVendor(vendor.id, { is_active: !vendor.is_active });
      toast.success(vendor.is_active ? "Archived" : "Restored");
      queryClient.invalidateQueries({ queryKey: ["vendors"] });
      void vendorMetrics.refetch();
    } catch (e) {
      toast.error(extractError(e));
    }
  }, [queryClient, vendorMetrics]);

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
        flex: true,
        minWidth: "12rem",
        maxWidth: "16rem",
        cell: (v) => (
          <span className="truncate font-medium text-foreground" title={toTitleCase(v.name)}>{toTitleCase(v.name)}</span>
        ),
        sortField: "name",
        sortable: true,
        searchable: true,
      },
      {
        id: "phone",
        header: "Phone",
        width: "8rem",
        cell: (v) =>
          v.phone ? (
            <span className="inline-flex items-center gap-1 truncate font-mono text-xs text-muted-foreground" title={v.phone}>
              <Phone className="h-3 w-3 shrink-0" />
              <span className="truncate">{v.phone}</span>
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
        width: "8rem",
        align: "right",
        cell: (v) => <Money paise={v.opening_balance ?? 0} muted />,
        sortField: "opening_balance_paise",
        sortable: true,
      },
      {
        id: "outstanding",
        header: "Outstanding",
        width: "8rem",
        align: "right",
        cell: (v) =>
          v.id in outstandings ? (
            <Money
              paise={outstandings[v.id]}
              negative={outstandings[v.id] < 0}
            />
          ) : (
            <span className="text-xs text-muted-foreground">…</span>
          ),
      },
    ];

    if (canEdit) {
      cols.push({
        id: "actions",
        header: "",
        width: "3.5rem",
        align: "right",
        cell: (v) => (
          <ActionMenu
            label={`Actions for ${v.name}`}
            items={[
              { label: v.is_active ? "Archive" : "Restore", icon: Archive, danger: v.is_active, onSelect: () => setArchiveConfirmVendor(v) },
            ]}
          />
        ),
      });
    }

    if (canPay) {
      cols.push({
        id: "action",
        header: "",
        width: "5rem",
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
  }, [canPay, canEdit, outstandings]);

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
  <Skeleton name="vendors-list" loading={vendorMetrics.isLoading} select="viewport">
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
        fill
      />

      <ConfirmDialog
        open={archiveConfirmVendor !== null}
        title={archiveConfirmVendor?.is_active ? "Archive this vendor?" : "Restore this vendor?"}
        body={archiveConfirmVendor?.is_active ? `${archiveConfirmVendor.name} will be hidden from search. Existing records are kept.` : `${archiveConfirmVendor?.name} will be visible again.`}
        confirmLabel={archiveConfirmVendor?.is_active ? "Archive" : "Restore"}
        destructive={archiveConfirmVendor?.is_active ?? false}
        onConfirm={() => { if (archiveConfirmVendor) { void handleArchive(archiveConfirmVendor); setArchiveConfirmVendor(null); } }}
        onCancel={() => setArchiveConfirmVendor(null)}
      />
    </div>
  </Skeleton>
  );
}
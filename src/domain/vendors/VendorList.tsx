/**
 * VendorList — searchable list with outstanding + role-gated Pay action.
 * Uses canonical SearchInput, DataTable, PaginationControls, and usePaginatedQuery.
 */
import { useEffect, useMemo, useState } from "react";
import { Banknote, Phone, Truck } from "lucide-react";

import { Alert, Button, DataTable, EmptyState, Money, PaginationControls, SearchInput } from '../../components/ui';
import type { ColumnDef } from "../../components/ui";
import { toast } from "../../lib/feedback/toast";
import { listVendors } from "./api";
import { outstandingReport } from "../../pos/api";
import { usePaginatedQuery } from "../../lib/query";
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

  const {
    data: items,
    allData,
    isLoading,
    isFetching,
    error,
    page,
    setPage,
    search,
    setSearch,
    totalItems,
    totalPages,
    pageSize,
    refetch,
  } = usePaginatedQuery<Vendor>({
    queryKey: ["vendors", refreshKey ?? 0],
    pageSize: PAGE_SIZE,
    queryFn: ({ search: debouncedSearch }) =>
      listVendors(debouncedSearch || undefined),
  });

  // Batch fetch outstanding report once the vendor list changes.
  useEffect(() => {
    let cancelled = false;
    if (allData.length === 0) {
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
  }, [allData]);

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
        header: "Name",
        cell: (v) => (
          <span className="font-medium text-foreground">{toTitleCase(v.name)}</span>
        ),
      },
      {
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
      },
      {
        header: "Opening",
        align: "right",
        cell: (v) => <Money paise={v.opening_balance ?? 0} muted />,
      },
      {
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
  useShortcut({ key: "F5", scope: "page", description: "Refresh list", onMatch: () => { void refetch(); } });
  useShortcut({
    key: "F6",
    scope: "page",
    description: "New vendor",
    onMatch: () => {
      if (canCreate && onCreate) onCreate();
    },
  });
  useShortcut({
    key: "Escape",
    allowInInputs: true,
    preventDefault: true,
    description: "Clear search",
    onMatch: () => {
      if (search) setSearch("");
    },
  });

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-2xl font-semibold tracking-tight">Vendors</h2>
          <p className="text-sm text-muted-foreground">
            {totalItems} {totalItems === 1 ? "vendor" : "vendors"}
            {search ? ` matching "${search}"` : ""}
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

      <div className="space-y-3">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search by name or phone…"
          ariaLabel="Search vendors"
          data-shortcut="search"
        />

        {error ? (
          <Alert title="Could not load vendors" variant="destructive">
            {extractError(error)}
          </Alert>
        ) : null}

        <DataTable
          data={items}
          columns={columns}
          keyExtractor={(v) => v.id}
          loading={isLoading || isFetching}
          emptyState={
            <EmptyState
              icon={Truck}
              title={search ? "No matches" : "No vendors yet"}
              description={
                search
                  ? `Nothing matches "${search}". Try a different search.`
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
          }
          error={error}
          onRetry={refetch}
          onRowClick={onSelect ? (v) => onSelect(v) : undefined}
          rowClassName={rowClassName}
        />

        {!isLoading && allData.length > 0 ? (
          <PaginationControls
            page={page}
            totalPages={totalPages}
            totalItems={totalItems}
            pageSize={pageSize}
            onPageChange={setPage}
          />
        ) : null}
      </div>
    </div>
  );
}

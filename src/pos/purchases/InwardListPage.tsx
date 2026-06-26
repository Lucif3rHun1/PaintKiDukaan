// Inward list page — recent purchases with search, date filter, pagination.

import { useMemo, useState } from "react";
import { PackagePlus, Truck } from "lucide-react";
import { PeriodDropdown } from "../../components/ui";

import { Button, Card, DataTable, EmptyState, Money, PaginationControls, SearchInput } from '../../components/ui';
import type { ColumnDef } from "../../components/ui";
import { listPurchases } from "../api";
import { usePaginatedQuery } from "../../lib/query";
import { formatDateForDisplay, shiftDaysLocal, todayLocalYyyymmdd } from "../../lib/date";
import { useShortcut } from "../../lib/shortcuts";
import { useFocusShortcut } from "../../lib/shortcuts/useFocusShortcut";
import type { Purchase } from "../types";

interface Props {
  onCreate: () => void;
  onSelect?: (id: number) => void;
}

const PAGE_SIZE = 25;

export function InwardListPage({ onCreate, onSelect }: Props) {
  const [from, setFrom] = useState(() => shiftDaysLocal(6));
  const [to, setTo] = useState(() => todayLocalYyyymmdd());

  const {
    data: rows,
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
  } = usePaginatedQuery<Purchase>({
    queryKey: ["inward-list", from, to],
    pageSize: PAGE_SIZE,
    queryFn: async () => {
      const purchases = await listPurchases(from, to, 500);
      return purchases ?? [];
    },
    clientFilter: (p, q) => {
      const term = q.toLowerCase();
      return (
        String(p.id).includes(term) ||
        (p.vendor_name ?? "").toLowerCase().includes(term) ||
        (p.notes ?? "").toLowerCase().includes(term)
      );
    },
  });

  const metrics = useMemo(() => {
    const totalValue = allData.reduce((sum, p) => sum + p.total, 0);
    return {
      count: allData.length,
      totalValue,
      avgOrder: allData.length > 0 ? Math.round(totalValue / allData.length) : 0,
    };
  }, [allData]);

  const columns = useMemo<ColumnDef<Purchase>[]>(
    () => [
      {
        id: "date",
        header: "Date",
        width: "7rem",
        cell: (p) => (
          <span className="text-foreground tabular-nums">{formatDateForDisplay(p.date)}</span>
        ),
      },
      {
        id: "vendor",
        header: "Vendor",
        width: "minmax(10rem, 1fr)",
        cell: (p) => (
          <span className="truncate text-foreground" title={p.vendor_name ?? "—"}>
            {p.vendor_name ?? "—"}
          </span>
        ),
      },
      {
        id: "no",
        header: "INW No",
        width: "7rem",
        cell: (p) => (
          <a
            href={`#/inward/${p.id}`}
            onClick={(e) => e.stopPropagation()}
            className="block max-w-full truncate font-mono tabular-nums text-foreground underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card rounded"
            aria-label={`Open inward ${p.id}`}
            title={String(p.id)}
          >
            #{p.id}
          </a>
        ),
      },
      {
        id: "items",
        header: "Items",
        width: "4rem",
        align: "right",
        cell: (p) => <span className="tabular-nums">{p.items.length}</span>,
      },
      {
        id: "total",
        header: "Total",
        width: "7rem",
        align: "right",
        cell: (p) => <Money paise={p.total} />,
      },
    ],
    [],
  );

  useFocusShortcut({ key: "F2", selector: '[data-shortcut="search"]', description: "Focus search" });
  useShortcut({ key: "F5", scope: "page", description: "Refresh list", onMatch: () => { void refetch(); } });
  useShortcut({ key: "F6", scope: "page", description: "New inward", onMatch: onCreate });
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
    <div className="space-y-3">
      {/* ── Metric cards ─────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-3">
        <Card as="section" className="space-y-1 p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Inwards</p>
          <p className="text-2xl font-semibold tabular-nums text-foreground">{metrics.count}</p>
        </Card>
        <Card as="section" className="space-y-1 p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Total value</p>
          <Money paise={metrics.totalValue} className="text-2xl font-semibold tabular-nums" />
        </Card>
        <Card as="section" className="space-y-1 p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Avg order</p>
          <Money paise={metrics.avgOrder} className="text-2xl font-semibold tabular-nums" />
        </Card>
      </div>

      {/* ── Filter bar ───────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search by vendor, notes…"
          ariaLabel="Search inwards"
          data-shortcut="search"
          className="min-w-[220px] flex-1"
        />
        <PeriodDropdown value={{ from, to }} onChange={(f, t) => { setFrom(f); setTo(t); }} allowCustom />
        <Button type="button" variant="primary" size="sm" icon={PackagePlus} onClick={onCreate} shortcut="F6">
          New Inward
        </Button>
      </div>

      <DataTable
        data={rows}
        columns={columns}
        keyExtractor={(p) => p.id}
        onRowClick={(p) => {
          if (onSelect) onSelect(p.id);
          else window.location.hash = `#/inward/${p.id}`;
        }}
        loading={isLoading || isFetching}
        error={error}
        onRetry={refetch}
        emptyState={
          <EmptyState
            icon={Truck}
            title={search ? "No matches" : "No inwards yet"}
            description={
              search
                ? `Nothing matches "${search}". Try a different search.`
                : "No inwards found for the selected range. Create the first inward to get started."
            }
            primary={
              <Button type="button" onClick={onCreate} icon={PackagePlus}>
                New Inward
              </Button>
            }
          />
        }
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
  );
}

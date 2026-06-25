// Inward list page — recent purchases with search, date filter, pagination.

import { useMemo, useState } from "react";
import { Plus, Truck } from "lucide-react";
import { DatePicker } from "../../components/ui/DatePicker";

import { Badge, Button, DataTable, EmptyState, Money, PaginationControls, SearchInput } from '../../components/ui';
import type { ColumnDef } from "../../components/ui";
import { listPurchases } from "../api";
import { usePaginatedQuery } from "../../lib/query";
import { formatDateForDisplay } from "../../lib/date";
import { useShortcut } from "../../lib/shortcuts";
import { useFocusShortcut } from "../../lib/shortcuts/useFocusShortcut";
import type { Purchase } from "../types";

interface Props {
  onCreate: () => void;
  onSelect?: (id: number) => void;
}

const PAGE_SIZE = 25;

export function InwardListPage({ onCreate, onSelect }: Props) {
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));

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
        (p.purchase_number ?? "").toLowerCase().includes(term) ||
        (p.vendor_name ?? "").toLowerCase().includes(term) ||
        (p.notes ?? "").toLowerCase().includes(term)
      );
    },
  });

  const columns = useMemo<ColumnDef<Purchase>[]>(
    () => [
      {
        header: "No",
        cell: (p) => (
          <a
            href={`#/inward/${p.id}`}
            className="font-mono tabular-nums text-foreground underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card rounded"
            aria-label={`Open inward ${p.purchase_number}`}
          >
            {p.purchase_number}
          </a>
        ),
      },
      {
        header: "Date",
        cell: (p) => (
          <span className="text-foreground">{formatDateForDisplay(p.date)}</span>
        ),
      },
      {
        header: "Status",
        cell: () => <Badge variant="info" size="sm">inward</Badge>,
      },
      {
        header: "Vendor",
        cell: (p) => (
          <span className="text-foreground">{p.vendor_name ?? "—"}</span>
        ),
      },
      {
        header: "Items",
        align: "right",
        cell: (p) => <span className="tabular-nums">{p.items.length}</span>,
      },
      {
        header: "Total",
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
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Inward
          </h1>
          <p className="text-sm text-muted-foreground">
            {totalItems} {totalItems === 1 ? "inward" : "inwards"}
            {search ? ` matching "${search}"` : ""}
          </p>
        </div>
        <Button
          type="button"
          variant="primary"
          size="md"
          icon={Plus}
          onClick={onCreate}
          shortcut="F6"
        >
          New Inward
        </Button>
      </header>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search by INW no, vendor, notes…"
            ariaLabel="Search inwards"
            data-shortcut="search"
            className="min-w-[220px] flex-1"
          />
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
            From
            <DatePicker value={from} onChange={setFrom} />
          </label>
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
            To
            <DatePicker value={to} onChange={setTo} />
          </label>
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
                <Button type="button" onClick={onCreate} icon={Plus}>
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
    </div>
  );
}

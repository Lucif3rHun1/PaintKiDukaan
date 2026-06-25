// Return list page — recent returns with search, date filter, and pagination.

import { useMemo, useState } from "react";
import { Plus, RotateCcw } from "lucide-react";
import { DatePicker } from "../../components/ui/DatePicker";

import { Badge, Button, DataTable, EmptyState, Money, PaginationControls, SearchInput } from '../../components/ui';
import type { ColumnDef } from "../../components/ui";
import { listSaleReturns } from "../../domain/ipc";
import type { SaleReturn } from "../../domain/types";
import { usePaginatedQuery } from "../../lib/query";
import { useShortcut } from "../../lib/shortcuts";
import { useFocusShortcut } from "../../lib/shortcuts/useFocusShortcut";
import { formatDateForDisplay } from "../../lib/date";

interface Props {
  onCreate: () => void;
  onSelect?: (id: number) => void;
}

const PAGE_SIZE = 25;

export function ReturnListPage({ onCreate, onSelect }: Props) {
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
  } = usePaginatedQuery<SaleReturn>({
    queryKey: ["returns-list", from, to],
    pageSize: PAGE_SIZE,
    queryFn: async () => {
      const returns = await listSaleReturns({ from_date: from, to_date: to, limit: 500 });
      return returns ?? [];
    },
    clientFilter: (ret, q) => {
      const term = q.toLowerCase();
      return (
        (ret.no ?? "").toLowerCase().includes(term) ||
        (ret.reason ?? "").toLowerCase().includes(term)
      );
    },
  });

  const columns = useMemo<ColumnDef<SaleReturn>[]>(
    () => [
      {
        header: "No",
        cell: (r) => (
          <a
            href={`#/sales/return/${r.id}`}
            className="font-mono tabular-nums text-foreground underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card rounded"
            aria-label={`Open return ${r.no}`}
          >
            {r.no}
          </a>
        ),
      },
      {
        header: "Date",
        cell: (r) => (
          <span className="text-foreground">{formatDateForDisplay(r.date)}</span>
        ),
      },
      {
        header: "Status",
        cell: (r) => (
          <Badge variant="info" size="sm">return</Badge>
        ),
      },
      {
        header: "Reason",
        cell: (r) => (
          <span className="truncate text-foreground">
            {r.reason ?? <span className="text-muted-foreground">—</span>}
          </span>
        ),
      },
      {
        header: "Total",
        align: "right",
        cell: (r) => <Money paise={r.refund_total} />,
      },
      {
        header: "Refunded",
        align: "right",
        cell: (r) => {
          const refunded = r.payment_modes.reduce((sum, m) => sum + m.amount, 0);
          return <Money paise={refunded} />;
        },
      },
    ],
    [],
  );

  useFocusShortcut({
    key: "F2",
    selector: '[data-shortcut="search"]',
    description: "Focus search",
  });
  useShortcut({
    key: "F5",
    scope: "page",
    description: "Refresh list",
    onMatch: () => {
      void refetch();
    },
  });
  useShortcut({
    key: "F6",
    scope: "page",
    description: "New return",
    onMatch: onCreate,
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
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Returns
          </h1>
          <p className="text-sm text-muted-foreground">
            {totalItems} {totalItems === 1 ? "return" : "returns"}
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
          New Return
        </Button>
      </header>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search by return no, reason…"
            ariaLabel="Search returns"
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
          keyExtractor={(r) => r.id}
          onRowClick={(r) => {
            if (onSelect) onSelect(r.id);
            else window.location.hash = `#/sales/return/${r.id}`;
          }}
          loading={isLoading || isFetching}
          error={error}
          onRetry={refetch}
          emptyState={
            <EmptyState
              icon={RotateCcw}
              title={search ? "No matches" : "No returns yet"}
              description={
                search
                  ? `Nothing matches "${search}". Try a different search.`
                  : "No returns found for the selected range. Create the first return to get started."
              }
              primary={
                <Button type="button" onClick={onCreate} icon={Plus}>
                  New Return
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

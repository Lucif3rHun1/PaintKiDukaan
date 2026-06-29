// Return list page — recent returns with search, date filter, and pagination.

import { useEffect, useMemo, useState } from "react";
import { Plus, RotateCcw } from "lucide-react";
import { PeriodDropdown } from "../../components/ui";

import { Badge, Button, Card, DataTable, EmptyState, Money, PaginationControls, SearchInput } from '../../components/ui';
import type { ColumnDef } from "../../components/ui";
import { listSaleReturns } from "../../domain/ipc";
import { getDraft } from "../api";
import type { SaleReturn, Draft } from "../../domain/types";
import { usePaginatedQuery } from "../../lib/query";
import { useShortcut } from "../../lib/shortcuts";
import { useFocusShortcut } from "../../lib/shortcuts/useFocusShortcut";
import { formatDateForDisplay, shiftDaysLocal, todayLocalYyyymmdd } from "../../lib/date";

interface Props {
  onCreate: () => void;
  onSelect?: (id: number) => void;
}

const PAGE_SIZE = 25;

export function ReturnListPage({ onCreate, onSelect }: Props) {
  const [from, setFrom] = useState(() => shiftDaysLocal(6));
  const [to, setTo] = useState(() => todayLocalYyyymmdd());
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => { void getDraft("return").then(setDraft); }, []);

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

  const metrics = useMemo(() => {
    const totalRefund = allData.reduce((sum, r) => sum + r.refund_total, 0);
    const totalRefunded = allData.reduce(
      (sum, r) => sum + r.payment_modes.reduce((s, m) => s + m.amount, 0),
      0,
    );
    return {
      count: allData.length,
      totalRefund,
      totalRefunded,
    };
  }, [allData]);

  const columns = useMemo<ColumnDef<SaleReturn>[]>(
    () => [
      {
        id: "date",
        header: "Date",
        width: "7rem",
        cell: (r) => (
          <span className="text-foreground tabular-nums">{formatDateForDisplay(r.date)}</span>
        ),
      },
      {
        id: "no",
        header: "Ret No",
        width: "8rem",
        cell: (r) => (
          <a
            href={`#/sales/return/${r.id}`}
            onClick={(e) => e.stopPropagation()}
            className="block max-w-full truncate font-mono tabular-nums text-foreground underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card rounded"
            aria-label={`Open return ${r.no}`}
            title={r.no}
          >
            {r.no}
          </a>
        ),
      },
      {
        id: "reason",
        header: "Reason",
        width: "minmax(10rem, 1fr)",
        cell: (r) => (
          <span className="truncate text-foreground" title={r.reason ?? ""}>
            {r.reason ?? <span className="text-muted-foreground">—</span>}
          </span>
        ),
      },
      {
        id: "total",
        header: "Refund",
        width: "7rem",
        align: "right",
        cell: (r) => <Money paise={r.refund_total} />,
      },
      {
        id: "refunded",
        header: "Refunded",
        width: "7rem",
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
    <div className="space-y-3">
      {/* ── Metric cards ─────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-3">
        <Card as="section" className="space-y-1 p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Returns</p>
          <p className="text-2xl font-semibold tabular-nums text-foreground">{metrics.count}</p>
        </Card>
        <Card as="section" className="space-y-1 p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Total refund</p>
          <Money paise={metrics.totalRefund} className="text-2xl font-semibold tabular-nums" />
        </Card>
        <Card as="section" className="space-y-1 p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Refunded</p>
          <Money paise={metrics.totalRefunded} className="text-2xl font-semibold tabular-nums" />
        </Card>
      </div>

      {/* ── Filter bar ───────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search by return no, reason…"
          ariaLabel="Search returns"
          data-shortcut="search"
          className="min-w-[220px] flex-1"
        />
        <PeriodDropdown value={{ from, to }} onChange={(f, t) => { setFrom(f); setTo(t); }} allowCustom />
        {draft && (
          <button type="button" onClick={() => { window.location.hash = "#/sales/return/new?restore=1"; }} className="inline-flex items-center gap-1.5 rounded-full border border-amber-300/50 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 hover:bg-amber-100 dark:border-amber-700/50 dark:bg-amber-950 dark:text-amber-300 dark:hover:bg-amber-900">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            Open draft
          </button>
        )}
        <Button type="button" variant="primary" size="sm" icon={Plus} onClick={onCreate} shortcut="F6">
          New Return
        </Button>
      </div>

      {draft && (() => {
        let label = "Untitled draft";
        let itemCount = 0;
        try {
          const data = JSON.parse(draft.data_json) as Record<string, unknown>;
          const lines = data.lines as { item_id?: number }[] | undefined;
          itemCount = lines?.length ?? 0;
          if (data.reason) label = String(data.reason);
        } catch { /* corrupt draft — still show it */ }
        const time = new Date(draft.updated_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        return (
          <button
            type="button"
            onClick={() => { window.location.hash = "#/sales/return/new?restore=1"; }}
            className="w-full flex items-center gap-3 rounded border border-amber-300/50 bg-amber-50/50 px-3 py-2 text-left text-sm hover:bg-amber-100/70 dark:border-amber-700/50 dark:bg-amber-950/50 dark:hover:bg-amber-900/50"
          >
            <Badge variant="warning" size="sm">Draft</Badge>
            <span className="flex-1 truncate text-foreground">{label}</span>
            <span className="text-xs tabular-nums text-muted-foreground">{itemCount} item{itemCount !== 1 ? "s" : ""}</span>
            <span className="text-xs text-muted-foreground">Saved {time}</span>
          </button>
        );
      })()}

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
  );
}

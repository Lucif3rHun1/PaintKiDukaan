// Return list page — recent returns with search, date filter, and pagination.

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, RotateCcw } from "lucide-react";
import { PeriodDropdown } from "../../components/ui";

import { Button, Card, DataList, EmptyState, Money } from '../../components/ui';
import type { ColumnDef } from "../../components/ui";
import { invalidateList } from "../../lib/query";
import { getDraft, listReturnsPaged, returnsPeriodSummary } from "../api";
import type { SaleReturn, Draft } from "../../domain/types";
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

  const summary = useQuery({
    queryKey: ["list-metrics", "cmd_sale_returns_period_summary", from, to],
    queryFn: () => returnsPeriodSummary(from, to),
  });

  const serverSource = useMemo(() => ({
    endpoint: "cmd_list_sale_returns_paged",
    pageSize: PAGE_SIZE,
    initialSort: { field: "created_at", dir: "desc" as const },
    filters: { from_date: from, to_date: to },
    clientFn: listReturnsPaged,
  }), [from, to]);

  const columns = useMemo<ColumnDef<SaleReturn>[]>(
    () => [
      {
        id: "date",
        header: "Date",
        width: "7rem",
        sortable: true,
        sortField: "date",
        cell: (r) => (
          <span className="text-foreground tabular-nums whitespace-nowrap">{formatDateForDisplay(r.date)}</span>
        ),
      },
      {
        id: "no",
        header: "Ret No",
        width: "11rem",
        sortable: true,
        sortField: "no",
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
        sortable: true,
        sortField: "refund_total",
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
      void summary.refetch();
    },
  });
  useShortcut({
    key: "F6",
    scope: "page",
    description: "New return",
    onMatch: onCreate,
  });

  const handleRowClick = (r: SaleReturn) => {
    if (onSelect) onSelect(r.id);
    else window.location.hash = `#/sales/return/${r.id}`;
  };

  const sm = summary.data;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <Card as="section" className="space-y-1 p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Returns</p>
          <p className="text-2xl font-semibold tabular-nums text-foreground">{sm?.count ?? "—"}</p>
        </Card>
        <Card as="section" className="space-y-1 p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Total refund</p>
          {sm ? (
            <Money paise={sm.total_refund_paise} className="text-2xl font-semibold tabular-nums" />
          ) : (
            <span className="text-2xl text-muted-foreground">—</span>
          )}
        </Card>
        <Card as="section" className="space-y-1 p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Refunded</p>
          {sm ? (
            <Money paise={sm.refunded_paise} className="text-2xl font-semibold tabular-nums" />
          ) : (
            <span className="text-2xl text-muted-foreground">—</span>
          )}
        </Card>
      </div>

      <DataList
        source={serverSource}
        columns={columns}
        keyExtractor={(r) => r.id}
        searchPlaceholder="Search by return no, reason…"
        onRowClick={handleRowClick}
        emptyMessage="No returns found"
        emptyCta={
          <EmptyState
            icon={RotateCcw}
            title="No returns yet"
            description="No returns found for the selected range. Create the first return to get started."
            primary={
              <Button type="button" onClick={onCreate} icon={Plus}>
                New Return
              </Button>
            }
          />
        }
        toolbar={
          <>
            <PeriodDropdown value={{ from, to }} onChange={(f, t) => { setFrom(f); setTo(t); }} allowCustom />
            {draft && (() => {
              let label = "Untitled draft";
              let itemCount = 0;
              try {
                const data = JSON.parse(draft.data_json) as Record<string, unknown>;
                const lines = data.lines as { item_id?: number }[] | undefined;
                itemCount = lines?.length ?? 0;
                if (data.reason) label = String(data.reason);
              } catch { /* corrupt draft */ }
              return (
                <button type="button" onClick={() => { window.location.hash = "#/sales/return/new?restore=1"; }} className="inline-flex items-center gap-1.5 rounded-full border border-amber-300/50 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 hover:bg-amber-100 dark:border-amber-700/50 dark:bg-amber-950 dark:text-amber-300 dark:hover:bg-amber-900">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                  Open draft ({itemCount} item{itemCount !== 1 ? "s" : ""})
                </button>
              );
            })()}
          </>
        }
        actions={
          <Button type="button" variant="primary" size="sm" icon={Plus} onClick={onCreate} shortcut="F6">
            New Return
          </Button>
        }
      />
    </div>
  );
}
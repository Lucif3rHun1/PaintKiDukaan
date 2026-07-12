// Inward list page — recent purchases with search, date filter, pagination.

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PackagePlus, Truck } from "lucide-react";
import { PeriodDropdown } from "../../components/ui";

import { Button, Card, DataList, EmptyState, Money } from '../../components/ui';
import type { ColumnDef } from "../../components/ui";
import { invalidateList } from "../../lib/query";
import { getDraft, listPurchasesPaged, purchasePeriodSummary } from "../api";
import { formatDateForDisplay, shiftDaysLocal, todayLocalYyyymmdd } from "../../lib/date";
import { useShortcut } from "../../lib/shortcuts";
import { useFocusShortcut } from "../../lib/shortcuts/useFocusShortcut";
import type { Purchase } from "../types";
import type { Draft } from "../../domain/types";
import { setHash } from "../../lib/navigate";

interface Props {
  onCreate: () => void;
  onSelect?: (id: number) => void;
}

const PAGE_SIZE = 25;

export function InwardListPage({ onCreate, onSelect }: Props) {
  const [from, setFrom] = useState(() => shiftDaysLocal(6));
  const [to, setTo] = useState(() => todayLocalYyyymmdd());
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => { void getDraft("purchase").then(setDraft); }, []);

  const summary = useQuery({
    queryKey: ["list-metrics", "cmd_purchase_period_summary", from, to],
    queryFn: () => purchasePeriodSummary(from, to),
  });

  const serverSource = useMemo(() => ({
    endpoint: "cmd_list_purchases_paged",
    pageSize: PAGE_SIZE,
    initialSort: { field: "created_at", dir: "desc" as const },
    filters: { from_date: from, to_date: to },
    clientFn: listPurchasesPaged,
  }), [from, to]);

  const columns = useMemo<ColumnDef<Purchase>[]>(
    () => [
      {
        id: "date",
        header: "Date",
        width: "7rem",
        sortable: true,
        sortField: "bill_date",
        cell: (p) => (
          <span className="text-foreground tabular-nums whitespace-nowrap">{formatDateForDisplay(p.date)}</span>
        ),
      },
      {
        id: "vendor",
        header: "Vendor",
        flex: true,
        minWidth: "8rem",
        maxWidth: "12rem",
        cell: (p) => (
          <span className="truncate text-foreground" title={p.vendor_name ?? "—"}>
            {p.vendor_name ?? "—"}
          </span>
        ),
      },
      {
        id: "no",
        header: "INW No",
        width: "13rem",
        cell: (p) => (
          <a
            href={`#/inward/${p.id}`}
            onClick={(e) => e.stopPropagation()}
            className="block max-w-full font-mono tabular-nums text-foreground underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card rounded whitespace-nowrap"
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
        sortable: true,
        sortField: "total_paise",
        cell: (p) => <Money paise={p.total} />,
      },
    ],
    [],
  );

  useFocusShortcut({ key: "F2", selector: '[data-shortcut="search"]', description: "Focus search" });
  useShortcut({ key: "F5", scope: "page", description: "Refresh list", onMatch: () => { void summary.refetch(); } });
  useShortcut({ key: "F6", scope: "page", description: "New inward", onMatch: onCreate });

  const handleRowClick = (p: Purchase) => {
    if (onSelect) onSelect(p.id);
    else setHash(`#/inward/${p.id}`);
  };

  const sm = summary.data;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <Card as="section" className="space-y-1 p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Inwards</p>
          <p className="text-2xl font-semibold tabular-nums text-foreground">{sm?.count ?? "—"}</p>
        </Card>
        <Card as="section" className="space-y-1 p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Total value</p>
          {sm ? (
            <Money paise={sm.total_paise} className="text-2xl font-semibold tabular-nums" />
          ) : (
            <span className="text-2xl text-muted-foreground">—</span>
          )}
        </Card>
        <Card as="section" className="space-y-1 p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Avg order</p>
          {sm ? (
            <Money paise={sm.avg_paise} className="text-2xl font-semibold tabular-nums" />
          ) : (
            <span className="text-2xl text-muted-foreground">—</span>
          )}
        </Card>
      </div>

      <DataList
        source={serverSource}
        columns={columns}
        keyExtractor={(p) => p.id}
        searchPlaceholder="Search by vendor, notes…"
        onRowClick={handleRowClick}
        emptyMessage="No inwards found"
        emptyCta={
          <EmptyState
            icon={Truck}
            title="No inwards yet"
            description="No inwards found for the selected range. Create the first inward to get started."
            primary={
              <Button type="button" onClick={onCreate} icon={PackagePlus}>
                New Inward
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
                const lines = data.draftLines as { item_name?: string }[] | undefined;
                itemCount = lines?.length ?? 0;
                if (data.notes) label = String(data.notes);
              } catch { /* corrupt draft */ }
              return (
                <button type="button" onClick={() => { setHash("#/inward/new?restore=1"); }} className="inline-flex items-center gap-1.5 rounded-full border border-amber-300/50 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 hover:bg-amber-100 dark:border-amber-700/50 dark:bg-amber-950 dark:text-amber-300 dark:hover:bg-amber-900">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                  Open draft ({itemCount} item{itemCount !== 1 ? "s" : ""})
                </button>
              );
            })()}
          </>
        }
        actions={
          <Button type="button" variant="primary" size="sm" icon={PackagePlus} onClick={onCreate} shortcut="F6">
            New Inward
          </Button>
        }
      />
    </div>
  );
}
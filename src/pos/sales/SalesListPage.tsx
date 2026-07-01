// Sales list page — recent sales with search, date filter, status chips,
// pagination, and at-a-glance totals (count, value).

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Eye, Plus, Printer, Receipt, RotateCcw, Share2, FilePenLine } from "lucide-react";
import { PeriodDropdown } from "../../components/ui";

import {
  ActionMenu,
  Badge,
  Button,
  Card,
  DataList,
  EmptyState,
  Money,
} from "../../components/ui";
import type { ColumnDef } from "../../components/ui";
import { invalidateList, invalidateListMetrics } from "../../lib/query";
import { getDraft, convertToFbill, listSalesPaged, salesPeriodSummary } from "../api";
import { useShortcut } from "../../lib/shortcuts";
import { useFocusShortcut } from "../../lib/shortcuts/useFocusShortcut";
import { formatDateForDisplay, shiftDaysLocal, todayLocalYyyymmdd } from "../../lib/date";
import type { Sale } from "../types";
import type { Draft } from "../../domain/types";
import {
  safeDownloadSalePdfById,
  safePrintSaleById,
  safeShareSalePdfById,
} from "./printOrDownload";
import { toast } from "../../lib/feedback/toast";
import { extractError } from "../../lib/extractError";
import { saleStatus } from "./saleStatus";

interface Props {
  onCreate: () => void;
}

const PAGE_SIZE = 25;

export function SalesListPage({ onCreate }: Props) {
  const queryClient = useQueryClient();
  const [from, setFrom] = useState(() => shiftDaysLocal(6));
  const [to, setTo] = useState(() => todayLocalYyyymmdd());
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    for (const key of ["sale-final", "sale-fbill", "sale-quotation"]) {
      void getDraft(key).then((d) => { if (d) setDraft(d); });
    }
  }, []);

  const summary = useQuery({
    queryKey: ["list-metrics", "cmd_sales_period_summary", from, to],
    queryFn: () => salesPeriodSummary(from, to),
  });

  const serverSource = useMemo(() => ({
    endpoint: "cmd_list_sales_paged",
    pageSize: PAGE_SIZE,
    initialSort: { field: "created_at", dir: "desc" as const },
    filters: { from_date: from, to_date: to },
    clientFn: listSalesPaged,
  }), [from, to]);

  const columns = useMemo<ColumnDef<Sale>[]>(
    () => [
      {
        id: "date",
        header: "Date",
        width: "7rem",
        sortable: true,
        sortField: "date",
        cell: (s) => (
          <span className="text-foreground tabular-nums">{formatDateForDisplay(s.date)}</span>
        ),
      },
      {
        id: "customer",
        header: "Customer",
        width: "minmax(10rem, 1fr)",
        sortable: true,
        sortField: "customer_name",
        cell: (s) => (
          <span className="truncate text-foreground" title={s.customer_name ?? "Walk-in"}>
            {s.customer_name ?? "Walk-in"}
          </span>
        ),
      },
      {
        id: "kind",
        header: "Kind",
        width: "5rem",
        cell: (s) => (
          <Badge variant="muted" size="sm">
            {s.status === "final" ? "Bill" : s.status === "fbill" ? "FBill" : "Quotation"}
          </Badge>
        ),
      },
      {
        id: "no",
        header: "Inv No",
        width: "8rem",
        cell: (s) => (
          <a
            href={`#/sales/${s.id}`}
            onClick={(e) => e.stopPropagation()}
            className="block max-w-full truncate font-mono tabular-nums text-foreground underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card rounded"
            aria-label={`Open invoice ${s.no}`}
            title={s.no}
          >
            {s.no}
          </a>
        ),
      },
      {
        id: "total",
        header: "Total",
        width: "7rem",
        align: "right",
        sortable: true,
        sortField: "total",
        cell: (s) => <Money paise={s.total} />,
      },
      {
        id: "paid",
        header: "Paid",
        width: "7rem",
        align: "right",
        cell: (s) => <Money paise={s.paid_amount} />,
      },
      {
        id: "status",
        header: "Status",
        width: "10rem",
        cell: (s) => {
          const { text, variant } = saleStatus(s);
          return (
            <Badge variant={variant} size="sm">
              {text}
            </Badge>
          );
        },
      },
    ],
    [],
  );

  const rowActions = (s: Sale) => (
    <ActionMenu
      label={`Actions for ${s.no}`}
      items={[
        {
          label: "View",
          icon: Eye,
          onSelect: () => (window.location.hash = `#/sales/${s.id}`),
        },
        {
          label: "Print",
          icon: Printer,
          onSelect: () => void safePrintSaleById(s.id),
        },
        {
          label: "Download PDF",
          icon: Download,
          onSelect: () => void safeDownloadSalePdfById(s.id),
        },
        {
          label: "Share",
          icon: Share2,
          onSelect: () => void safeShareSalePdfById(s.id),
        },
        ...(s.status === "final"
          ? [
              {
                label: "Convert to FBill",
                icon: FilePenLine,
                onSelect: async () => {
                  try {
                    const newId = await convertToFbill(s.id);
                    toast.success("Bill converted successfully");
                    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
                    void queryClient.invalidateQueries({ queryKey: ["items"] });
                    void queryClient.invalidateQueries({ queryKey: ["sales-list"] });
                    void invalidateList(queryClient, "cmd_list_sales_paged");
                    void invalidateListMetrics(queryClient, "cmd_sales_period_summary");
                    window.location.hash = `#/sales/edit/${newId}`;
                  } catch (e) {
                    toast.error(`Convert failed: ${extractError(e)}`);
                  }
                },
              },
              {
                label: "Return items",
                icon: RotateCcw,
                onSelect: () => {
                  window.location.hash = `#/sales/return?preLink=${s.id}`;
                },
              },
            ]
          : []),
      ]}
    />
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
    description: "New sale",
    onMatch: onCreate,
  });

  const sm = summary.data;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Card as="section" className="space-y-1 p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Invoices</p>
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
      </div>

      <DataList
        source={serverSource}
        columns={columns}
        keyExtractor={(s) => s.id}
        searchPlaceholder="Search by invoice, customer…"
        onRowClick={(s) => (window.location.hash = `#/sales/${s.id}`)}
        emptyMessage="No sales found"
        emptyCta={
          <EmptyState
            icon={Receipt}
            title="No sales yet"
            description="No sales found for the selected range. Create the first sale to get started."
            primary={
              <Button type="button" onClick={onCreate} icon={Plus}>
                New Sale
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
                if (!data.customerId) label = "Walk-in";
              } catch { /* corrupt draft */ }
              return (
                <button type="button" onClick={() => { window.location.hash = "#/sales/new?restore=1"; }} className="inline-flex items-center gap-1.5 rounded-full border border-amber-300/50 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 hover:bg-amber-100 dark:border-amber-700/50 dark:bg-amber-950 dark:text-amber-300 dark:hover:bg-amber-900">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                  Open draft ({itemCount} item{itemCount !== 1 ? "s" : ""})
                </button>
              );
            })()}
          </>
        }
        actions={
          <Button type="button" variant="primary" size="sm" icon={Plus} onClick={onCreate} shortcut="F6">
            New Sale
          </Button>
        }
        rowActions={rowActions}
      />
    </div>
  );
}
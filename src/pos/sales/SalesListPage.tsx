// Sales list page — recent sales with search, date filter, status chips,
// pagination, and at-a-glance totals (count, value).

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Banknote,
  Download,
  Eye,
  Plus,
  Printer,
  Receipt,
  RotateCcw,
  Share2,
  FilePenLine,
  TrendingUp,
} from "lucide-react";
import { PeriodDropdown } from "../../components/ui";

import {
  ActionMenu,
  Badge,
  Button,
  DataList,
  EmptyState,
  MetricCard,
  Money,
} from "../../components/ui";
import type { ColumnDef } from "../../components/ui";
import { invalidateList, invalidateListMetrics } from "../../lib/query";
import { getDraft, convertToFbill, listSalesPaged, salesPeriodSummary } from "../api";
import { useShortcut } from "../../lib/shortcuts";
import { useFocusShortcut } from "../../lib/shortcuts/useFocusShortcut";
import { formatDateForDisplay, shiftDaysLocal, todayLocalYyyymmdd } from "../../lib/date";
import { formatRupeesFromPaise } from "../../lib/money";
import type { Sale } from "../types";
import type { Draft } from "../../domain/types";
import { setHash } from "../../lib/navigate";
import {
  safeDownloadSalePdfById,
  safePrintSaleById,
  safeShareSalePdfById,
} from "./printOrDownload";
import { toast } from "../../lib/feedback/toast";
import { extractError } from "../../lib/extractError";
import { saleStatus } from "./saleStatus";
import { Skeleton } from "boneyard-js/react";

interface Props {
  onCreate: () => void;
}

const PAGE_SIZE = 25;

function draftItemCount(draft: Draft): number {
  try {
    const data: unknown = JSON.parse(draft.data_json);
    if (typeof data !== "object" || data === null || !("lines" in data)) return 0;
    return Array.isArray(data.lines) ? data.lines.length : 0;
  } catch {
    return 0;
  }
}

export function SalesListPage({ onCreate }: Props) {
  const queryClient = useQueryClient();
  const [from, setFrom] = useState(() => shiftDaysLocal(6));
  const [to, setTo] = useState(() => todayLocalYyyymmdd());
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      ["sale-final", "sale-fbill", "sale-quotation"].map((key) => getDraft(key)),
    ).then((drafts) => {
      if (cancelled) return;
      setDraft(
        drafts.find(
          (candidate): candidate is Draft => candidate !== null && draftItemCount(candidate) > 0,
        ) ?? null,
      );
    });
    return () => { cancelled = true; };
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
          <span className="text-foreground tabular-nums whitespace-nowrap">{formatDateForDisplay(s.date)}</span>
        ),
      },
      {
        id: "customer",
        header: "Customer",
        flex: true,
        minWidth: "8rem",
        maxWidth: "12rem",
        sortable: true,
        sortField: "customer_name",
        cell: (s) => (
          <span className="truncate text-foreground" title={s.customer_name ?? "Walk-in"}>
            {s.customer_name ?? "Walk-in"}
          </span>
        ),
      },
      {
        id: "no",
        header: "Inv No",
        width: "13rem",
        cell: (s) => (
          <a
            href={`#/sales/${s.id}`}
            onClick={(e) => e.stopPropagation()}
            className="block max-w-full font-mono tabular-nums text-foreground underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card rounded whitespace-nowrap"
            aria-label={`Open invoice ${s.no}`}
            title={s.no}
          >
            {s.no}
          </a>
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
          onSelect: () => (setHash(`#/sales/${s.id}`)),
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
                    setHash(`#/sales/edit/${newId}`);
                  } catch (e) {
                    toast.error(`Convert failed: ${extractError(e)}`);
                  }
                },
              },
              {
                label: "Return items",
                icon: RotateCcw,
                onSelect: () => {
                  setHash(`#/sales/return?preLink=${s.id}`);
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
  const totalSales = Math.max(0, sm?.total_paise ?? 0);
  const collected = Math.min(totalSales, Math.max(0, sm?.paid_paise ?? 0));
  const onCredit = totalSales - collected;
  const collectedPercent = totalSales > 0 ? Math.round((collected / totalSales) * 100) : 0;

  return (
  <Skeleton name="sales-list" loading={summary.isLoading} select="viewport" className="min-h-0 flex-1 [&>[data-boneyard-content]]:h-full">
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard
          icon={Receipt}
          label="Invoices"
          loading={summary.isLoading}
          tone="primary"
          footer={<span className="text-xs text-muted-foreground">in selected period</span>}
        >
          <span className="tabular-nums">{sm?.count ?? "—"}</span>
        </MetricCard>
        <MetricCard
          icon={Banknote}
          label="Total sales"
          loading={summary.isLoading}
          tone="success"
          footer={sm ? (
            <div className="space-y-2 text-xs text-muted-foreground">
              <div
                role="progressbar"
                aria-label="Collected share"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={collectedPercent}
                className="h-1.5 overflow-hidden rounded-full bg-muted"
              >
                <div className="h-full rounded-full bg-success" style={{ width: `${collectedPercent}%` }} />
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <span>Collected {formatRupeesFromPaise(collected)}</span>
                <span>On credit {formatRupeesFromPaise(onCredit)}</span>
              </div>
            </div>
          ) : null}
        >
          {sm ? (
            <Money paise={sm.total_paise} className="tabular-nums" />
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </MetricCard>
        <MetricCard
          icon={TrendingUp}
          label="Avg bill"
          loading={summary.isLoading}
          tone="info"
          footer={<span className="text-xs text-muted-foreground">per invoice</span>}
        >
          {sm ? (
            <Money paise={sm.avg_paise} className="tabular-nums" />
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </MetricCard>
      </div>

      <DataList
        source={serverSource}
        columns={columns}
        keyExtractor={(s) => s.id}
        searchPlaceholder="Search by invoice, customer…"
        estimateRowHeight={44}
        fill
        onRowClick={(s) => (setHash(`#/sales/${s.id}`))}
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
            {draft && draftItemCount(draft) > 0 && (
              <Button type="button" variant="outline" size="sm" onClick={() => { setHash("#/sales/new?restore=1"); }}>
                <Badge variant="warning" size="sm">Draft</Badge>
                Open ({draftItemCount(draft)} item{draftItemCount(draft) !== 1 ? "s" : ""})
              </Button>
            )}
          </>
        }
        actions={
          <Button type="button" size="sm" icon={Plus} onClick={onCreate} shortcut="F6">
            New Sale
          </Button>
        }
        rowActions={rowActions}
      />
    </div>
  </Skeleton>
  );
}

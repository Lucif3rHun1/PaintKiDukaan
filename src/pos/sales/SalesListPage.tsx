// Sales list page — recent sales with search, date filter, status chips,
// pagination, and at-a-glance totals (count, value, outstanding due).

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Download, Eye, Plus, Printer, Receipt, Share2, FilePenLine } from "lucide-react";
import { PeriodDropdown } from "../../components/ui";

import {
  ActionMenu,
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Money,
  PaginationControls,
  SearchInput,
} from "../../components/ui";
import type { ColumnDef } from "../../components/ui";
import { listSales, getDraft, convertToFbill } from "../api";
import { usePaginatedQuery } from "../../lib/query";
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

type PaymentFilter = "all" | "paid" | "partial" | "due";

export function SalesListPage({ onCreate }: Props) {
  const queryClient = useQueryClient();
  const [from, setFrom] = useState(() => shiftDaysLocal(6));
  const [to, setTo] = useState(() => todayLocalYyyymmdd());
  const [payFilter, setPayFilter] = useState<PaymentFilter>("all");
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => { void getDraft("sale").then(setDraft); }, []);

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
  } = usePaginatedQuery<Sale>({
    queryKey: ["sales-list", from, to],
    pageSize: PAGE_SIZE,
    queryFn: async () => {
      const sales = await listSales(from, to, 500);
      return sales ?? [];
    },
    clientFilter: (sale, q) => {
      const term = q.toLowerCase();
      return (
        (sale.no ?? "").toLowerCase().includes(term) ||
        (sale.customer_name ?? "walk-in").toLowerCase().includes(term)
      );
    },
  });

  // Metric cards (computed from full filtered set, not just current page).
  const metrics = useMemo(() => {
    const finals = allData.filter((s) => s.status === "final");
    const totalValue = finals.reduce((sum, s) => sum + s.total, 0);
    let paidCount = 0;
    let paidTotal = 0;
    let partialCount = 0;
    let partialTotal = 0;
    let dueCount = 0;
    let dueTotal = 0;
    for (const s of finals) {
      const balance = s.total - s.paid_amount;
      if (balance <= 0) {
        paidCount++;
        paidTotal += s.total;
      } else if (s.paid_amount > 0) {
        partialCount++;
        partialTotal += balance;
      } else {
        dueCount++;
        dueTotal += s.total;
      }
    }
    return { count: finals.length, totalValue, paidCount, paidTotal, partialCount, partialTotal, dueCount, dueTotal };
  }, [allData]);

  const statusFilterFn = useMemo(() => {
    if (payFilter === "all") return null;
    return (s: Sale) => {
      if (s.status !== "final") return false;
      const balance = s.total - s.paid_amount;
      if (payFilter === "paid") return balance <= 0;
      if (payFilter === "due") return balance > 0 && s.paid_amount <= 0;
      return balance > 0 && s.paid_amount > 0;
    };
  }, [payFilter]);

  const filteredAllData = useMemo(
    () => statusFilterFn ? allData.filter(statusFilterFn) : allData,
    [allData, statusFilterFn],
  );

  const displayedRows = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filteredAllData.slice(start, start + PAGE_SIZE);
  }, [filteredAllData, page]);

  const filteredTotalItems = filteredAllData.length;
  const filteredTotalPages = Math.max(1, Math.ceil(filteredTotalItems / PAGE_SIZE));

  useEffect(() => { setPage(1); }, [payFilter, setPage]);

  const columns = useMemo<ColumnDef<Sale>[]>(
    () => [
      {
        id: "date",
        header: "Date",
        width: "7rem",
        cell: (s) => (
          <span className="text-foreground tabular-nums">{formatDateForDisplay(s.date)}</span>
        ),
      },
      {
        id: "customer",
        header: "Customer",
        width: "minmax(10rem, 1fr)",
        cell: (s) => (
          <span className="truncate text-foreground" title={s.customer_name ?? "Walk-in"}>
            {s.customer_name ?? "Walk-in"}
          </span>
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
      {
        header: "",
        id: "actions",
        align: "right",
        width: "3rem",
        cell: (s) => (
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
                          window.location.hash = `#/sales/edit/${newId}`;
                        } catch (e) {
                          toast.error(`Convert failed: ${extractError(e)}`);
                        }
                      },
                    },
                  ]
                : []),
            ]}
          />
        ),
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
    description: "New sale",
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
      <div className="grid gap-3 sm:grid-cols-3">
        <Card as="section" className="space-y-1 p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Invoices</p>
          <p className="text-2xl font-semibold tabular-nums text-foreground">{metrics.count}</p>
        </Card>
        <Card as="section" className="space-y-1 p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Total value</p>
          <Money paise={metrics.totalValue} className="text-2xl font-semibold tabular-nums" />
        </Card>
        <Card as="section" className="p-4">
          <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Payment summary</p>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-0.5">
              <p className="text-xs text-success">Paid</p>
              <p className="text-lg font-semibold tabular-nums text-success">{metrics.paidCount}</p>
              <Money paise={metrics.paidTotal} className="text-xs tabular-nums text-success" />
            </div>
            <div className="space-y-0.5">
              <p className="text-xs text-warning">Partial</p>
              <p className="text-lg font-semibold tabular-nums text-warning">{metrics.partialCount}</p>
              <Money paise={metrics.partialTotal} className="text-xs tabular-nums text-warning" />
            </div>
            <div className="space-y-0.5">
              <p className="text-xs text-destructive">Due</p>
              <p className="text-lg font-semibold tabular-nums text-destructive">{metrics.dueCount}</p>
              <Money paise={metrics.dueTotal} className="text-xs tabular-nums text-destructive" />
            </div>
          </div>
        </Card>
      </div>

      {/* ── Filter bar ───────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search by invoice, customer…"
          ariaLabel="Search sales"
          data-shortcut="search"
          className="min-w-[220px] flex-1"
        />
        <PeriodDropdown value={{ from, to }} onChange={(f, t) => { setFrom(f); setTo(t); }} allowCustom />
        {draft && (
          <button type="button" onClick={() => { window.location.hash = "#/sales/new?restore=1"; }} className="inline-flex items-center gap-1.5 rounded-full border border-amber-300/50 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 hover:bg-amber-100 dark:border-amber-700/50 dark:bg-amber-950 dark:text-amber-300 dark:hover:bg-amber-900">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            Open draft
          </button>
        )}
        <Button type="button" variant="primary" size="sm" icon={Plus} onClick={onCreate} shortcut="F6">
          New Sale
        </Button>
      </div>

      <div
        className="flex flex-wrap items-center gap-2"
        role="tablist"
        aria-label="Payment status filter"
        onKeyDown={(e) => {
          const chips: PaymentFilter[] = ["all", "paid", "partial", "due"];
          const idx = chips.indexOf(payFilter);
          if (idx < 0) return;
          if (e.key === "ArrowRight" || e.key === "ArrowDown") {
            e.preventDefault();
            setPayFilter(chips[(idx + 1) % chips.length]);
          } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
            e.preventDefault();
            setPayFilter(chips[(idx - 1 + chips.length) % chips.length]);
          }
        }}
      >
        {(
          [
            { id: "all", label: "All" },
            { id: "paid", label: "Fully paid" },
            { id: "partial", label: "Partial" },
            { id: "due", label: "Due" },
          ] as { id: PaymentFilter; label: string }[]
        ).map((chip) => {
          const active = payFilter === chip.id;
          return (
            <button
              key={chip.id}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => setPayFilter(chip.id)}
              className={
                active
                  ? "rounded-full border border-primary bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                  : "rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
              }
            >
              {chip.label}
            </button>
          );
        })}
      </div>

      {draft && (() => {
        let label = "Untitled draft";
        let itemCount = 0;
        try {
          const data = JSON.parse(draft.data_json) as Record<string, unknown>;
          const lines = data.lines as { item_id?: number }[] | undefined;
          itemCount = lines?.length ?? 0;
          if (data.customerId) label = `Walk-in`;
        } catch { /* corrupt draft — still show it */ }
        const time = new Date(draft.updated_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        return (
          <button
            type="button"
            onClick={() => { window.location.hash = "#/sales/new?restore=1"; }}
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
        data={displayedRows}
        columns={columns}
        keyExtractor={(s) => s.id}
        onRowClick={(s) => (window.location.hash = `#/sales/${s.id}`)}
        loading={isLoading || isFetching}
        error={error}
        onRetry={refetch}
        emptyState={
          <EmptyState
            icon={Receipt}
            title={search || payFilter !== "all" ? "No matches" : "No sales yet"}
            description={
              search
                ? `Nothing matches "${search}". Try a different search.`
                : payFilter !== "all"
                  ? `No ${payFilter === "paid" ? "fully paid" : payFilter} sales in this range.`
                  : "No sales found for the selected range. Create the first sale to get started."
            }
            primary={
              <Button type="button" onClick={onCreate} icon={Plus}>
                New Sale
              </Button>
            }
          />
        }
      />

      {!isLoading && filteredAllData.length > 0 ? (
        <PaginationControls
          page={page}
          totalPages={filteredTotalPages}
          totalItems={filteredTotalItems}
          pageSize={pageSize}
          onPageChange={setPage}
        />
      ) : null}
    </div>
  );
}

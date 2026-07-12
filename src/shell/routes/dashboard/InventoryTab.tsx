import { useState } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  Banknote,
  PackageOpen,
  Receipt,
  ShoppingCart,
  TrendingUp,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Card, EmptyState, MetricCard, Money, PeriodDropdown, Skeleton, TopItemsCard, formatQtyValue, ConcernCard, DonutCard, Button } from "../../../components/ui";
import { TopMetricsRow, type TopMetric } from "./TopMetricsRow";
import {
  dailySales,
  deadStock,
  inventoryAging,
  inventoryTurnover,
  stockHealthSummary,
  stockReport,
  topItemsPurchased,
  topItemsSold,
} from "../../../pos/api";
import { listBrands, listItems } from "../../../domain/items/api";
import { formatItemName } from "../../../domain/items/display";
import { formatDateForDisplay, todayLocalYyyymmdd, shiftDaysLocal } from "../../../lib/date";
import { useMediaQuery } from "../../../lib/hooks/useMediaQuery";


const STAGGER_INVENTORY = 32_000;

export function InventoryTab() {
  const brands = useQuery({ queryKey: ["brands"], queryFn: listBrands });
  const [byCategoryMode, setByCategoryMode] = useState<"value" | "qty">("value");
  const [fromDate, setFromDate] = useState(() => shiftDaysLocal(6));
  const [toDate, setToDate] = useState(() => todayLocalYyyymmdd());

  const stockHealth = useQuery({
    queryKey: ["dashboard", "stockHealth"],
    queryFn: () => stockHealthSummary(),
    refetchInterval: STAGGER_INVENTORY,
  });

  const stockReportQuery = useQuery({
    queryKey: ["dashboard", "stockReport"],
    queryFn: () => stockReport(),
    refetchInterval: STAGGER_INVENTORY,
  });

  const lowStock = useQuery({
    queryKey: ["dashboard", "lowStock"],
    queryFn: () => listItems({ low_stock_only: true, limit: 8 }),
    refetchInterval: STAGGER_INVENTORY,
  });

  const deadStockQuery = useQuery({
    queryKey: ["dashboard", "deadStock", 60],
    queryFn: () => deadStock(60),
    refetchInterval: STAGGER_INVENTORY,
  });

  const agingQuery = useQuery({
    queryKey: ["dashboard", "inventoryAging"],
    queryFn: () => inventoryAging(),
    refetchInterval: STAGGER_INVENTORY,
  });

  const turnoverQuery = useQuery({
    queryKey: ["dashboard", "inventoryTurnover"],
    queryFn: () => inventoryTurnover(),
    refetchInterval: STAGGER_INVENTORY,
  });

  const periodSales = useQuery({
    queryKey: ["dashboard", "sales", "period", fromDate, toDate],
    queryFn: () => dailySales(fromDate, toDate),
    refetchInterval: STAGGER_INVENTORY,
  });

  const topSold = useQuery({
    queryKey: ["dashboard", "topItemsSold", fromDate, toDate],
    queryFn: () => topItemsSold(fromDate || undefined, toDate || undefined, 5),
    refetchInterval: STAGGER_INVENTORY,
  });
  const topPurchased = useQuery({
    queryKey: ["dashboard", "topItemsPurchased", fromDate, toDate],
    queryFn: () => topItemsPurchased(fromDate || undefined, toDate || undefined, 5),
    refetchInterval: STAGGER_INVENTORY,
  });

  const health = stockHealth.data;
  const byGroup = stockReportQuery.data?.by_group ?? [];
  const maxGroupValue = Math.max(...byGroup.map((g) => g.total_retail_value), 1);
  const maxGroupQty = Math.max(...byGroup.map((g) => g.total_qty), 1);
  const aging = agingQuery.data;
  const agingTotal = aging
    ? Math.max(
        aging.bucket_0_30 + aging.bucket_31_60 + aging.bucket_61_90 + aging.bucket_91_plus,
        1,
      )
    : 1;

  const isMobile = useMediaQuery("(max-width: 767px)");
  const [showAll, setShowAll] = useState(false);
  const condensed = isMobile && !showAll;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">
          Inventory Overview
        </h2>
        <PeriodDropdown
          value={{ from: fromDate, to: toDate }}
          onChange={(f, t) => { setFromDate(f); setToDate(t); }}
        />
      </div>
      <TopMetricsRow
        label="Inventory metrics"
        gridClassName="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
        metrics={[
          {
            id: "inventory-total-items",
            label: "Total Items (active)",
            icon: PackageOpen,
            tone: "info",
            loading: stockHealth.isLoading,
            value: <span className="text-xl font-semibold tabular-nums">{health?.total_active_items ?? 0}</span>,
          },
          {
            id: "inventory-stock-value",
            label: "Stock Value (retail)",
            icon: Banknote,
            tone: "primary",
            loading: stockHealth.isLoading,
            value: <Money paise={health?.retail_value_paise ?? 0} className="text-xl font-semibold" />,
          },
          {
            id: "inventory-low-stock",
            label: "Low Stock",
            icon: AlertTriangle,
            tone: "warning",
            loading: stockHealth.isLoading,
            value: <span className="text-xl font-semibold tabular-nums">{health?.low_count ?? 0}</span>,
          },
          {
            id: "inventory-zero-stock",
            label: "Zero Stock",
            icon: Receipt,
            tone: "destructive",
            loading: stockHealth.isLoading,
            value: <span className="text-xl font-semibold tabular-nums">{health?.zero_count ?? 0}</span>,
          },
          {
            id: "inventory-stock-turnover",
            label: "Stock Turnover",
            icon: TrendingUp,
            tone: "primary",
            loading: turnoverQuery.isLoading || periodSales.isLoading,
            value: (
              <span className="text-xl font-semibold tabular-nums">
                {(() => {
                  const stockVal = turnoverQuery.data?.stock_value_paise ?? 0;
                  const salesVal = periodSales.data?.grand_total ?? 0;
                  return stockVal > 0 ? (salesVal / stockVal).toFixed(1) : "—";
                })()}
              </span>
            ),
          },
        ] satisfies TopMetric[]}
      />

      {isMobile && (
        <div className="flex justify-center">
          <Button variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Show less" : "View full dashboard"}
          </Button>
        </div>
      )}

      <section className={`grid grid-cols-1 gap-3 lg:grid-cols-2 ${condensed ? "hidden" : ""}`}>
        <Card>
          <Card.Header>
            <h3 className="text-sm font-semibold">Stock Health</h3>
          </Card.Header>
          <Card.Body>
            {stockHealth.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : (
              <DonutCard
                segments={[
                  { name: "Healthy", value: health?.healthy_count ?? 0, colorClass: "bg-success", fill: "hsl(var(--success))" },
                  { name: "Low", value: health?.low_count ?? 0, colorClass: "bg-warning", fill: "hsl(var(--warning))" },
                  { name: "Zero", value: health?.zero_count ?? 0, colorClass: "bg-destructive", fill: "hsl(var(--destructive))" },
                  { name: "Negative", value: health?.negative_count ?? 0, colorClass: "bg-info", fill: "hsl(var(--info))" },
                ]}
              />
            )}
          </Card.Body>
        </Card>

        <ConcernCard
          title="Low Stock & Reorder Alerts"
          items={(lowStock.data ?? []).slice(0, 8).map((item) => ({
            id: item.id,
            name: formatItemName(item, brands.data ?? []),
          }))}
          loading={lowStock.isLoading}
          statusFn={(item) => ((lowStock.data ?? []).find((x) => x.id === item.id)?.current_qty ?? 0) <= 0 ? "destructive" : "warning"}
          renderStatus={(item) => {
            const raw = (lowStock.data ?? []).find((x) => x.id === item.id);
            if (!raw) return null;
            if (raw.current_qty < 0) return `Negative stock (${raw.current_qty})`;
            if (raw.current_qty === 0) return "Out of stock";
            return `${raw.current_qty} / min ${raw.min_stock}`;
          }}
          headerAction={
            <a href="#/items" className="text-xs text-muted-foreground hover:text-foreground">
              View all
            </a>
          }
          emptyState={{ icon: <PackageOpen />, title: "All items are well-stocked.", description: "No items below their reorder threshold." }}
        />
      </section>

      <section className={`grid grid-cols-1 gap-3 lg:grid-cols-2 ${condensed ? "hidden" : ""}`}>
        <TopItemsCard
          title="Top Moving Items"
          items={(topSold.data ?? []).slice(0, 5).map((r) => ({
            id: r.item_id,
            name: r.name,
            value: formatQtyValue(r.total_qty, r.total_value),
          }))}
          loading={topSold.isLoading}
          badgeTone="primary"
          emptyState={{ icon: <ShoppingCart />, title: "No sales in this range", description: "Top sellers will appear here." }}
        />

        <Card>
          <Card.Header className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Stock by Category</h3>
            <div className="flex gap-1 rounded-md border border-border bg-card p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setByCategoryMode("value")}
                aria-pressed={byCategoryMode === "value"}
                className={
                  byCategoryMode === "value"
                    ? "rounded bg-primary px-2 py-0.5 text-primary-foreground"
                    : "rounded px-2 py-0.5 text-muted-foreground hover:text-foreground"
                }
              >
                Value
              </button>
              <button
                type="button"
                onClick={() => setByCategoryMode("qty")}
                aria-pressed={byCategoryMode === "qty"}
                className={
                  byCategoryMode === "qty"
                    ? "rounded bg-primary px-2 py-0.5 text-primary-foreground"
                    : "rounded px-2 py-0.5 text-muted-foreground hover:text-foreground"
                }
              >
                Qty
              </button>
            </div>
          </Card.Header>
          <Card.Body>
            {stockReportQuery.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : byGroup.length === 0 ? (
              <EmptyState
                icon={Receipt}
                title="No category data"
                description="Stock grouped by brand/category will appear here."
              />
            ) : (
              <ul className="space-y-2">
                {byGroup.map((g) => {
                  const value = byCategoryMode === "value" ? g.total_retail_value : g.total_qty;
                  const max = byCategoryMode === "value" ? maxGroupValue : maxGroupQty;
                  const pct = (value / max) * 100;
                  return (
                    <li key={g.group} className="space-y-1">
                      <div className="flex items-center justify-between text-sm">
                        <span className="truncate font-medium">{g.group}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {byCategoryMode === "value" ? (
                            <Money paise={value} compact />
                          ) : (
                            `${value}`
                          )}
                        </span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card.Body>
        </Card>
      </section>

      <section className={`grid grid-cols-1 gap-3 lg:grid-cols-2 ${condensed ? "hidden" : ""}`}>
        <ConcernCard
          title="Dead Stock (60+ days idle)"
          items={(deadStockQuery.data ?? []).slice(0, 8).map((r) => ({ id: r.item_id, name: r.name }))}
          loading={deadStockQuery.isLoading}
          statusFn={() => "warning"}
          renderStatus={(item) => {
            const raw = (deadStockQuery.data ?? []).find((x) => x.item_id === item.id);
            if (!raw) return null;
            return (
              <>
                <span className="text-foreground">{raw.current_qty} units</span>
                <span className="opacity-75">
                  {raw.last_sale_ms ? formatDateForDisplay(new Date(raw.last_sale_ms)) : "never"}
                </span>
              </>
            );
          }}
          emptyState={{ icon: <TrendingUp />, title: "All stock is moving", description: "No items without sales in the last 60 days." }}
        />

        <Card>
          <Card.Header>
            <h3 className="text-sm font-semibold">Inventory Aging</h3>
          </Card.Header>
          <Card.Body>
            {agingQuery.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : !aging ? (
              <Skeleton className="h-24 w-full" />
            ) : (
              <ul className="space-y-2">
                {[
                  { label: "0–30 days", count: aging.bucket_0_30 },
                  { label: "31–60 days", count: aging.bucket_31_60 },
                  { label: "61–90 days", count: aging.bucket_61_90 },
                  { label: "91+ days", count: aging.bucket_91_plus },
                ].map((b) => {
                  const pct = (b.count / agingTotal) * 100;
                  return (
                    <li key={b.label} className="space-y-1">
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-medium">{b.label}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {b.count} items · {pct.toFixed(0)}%
                        </span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className={
                            b.label === "91+ days"
                              ? "h-full rounded-full bg-destructive"
                              : b.label === "61–90 days"
                                ? "h-full rounded-full bg-warning"
                                : "h-full rounded-full bg-primary"
                          }
                          style={{ width: `${pct > 0 ? Math.max(pct, 2) : 0}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card.Body>
        </Card>
      </section>

      <TopItemsCard
        title="Top Purchased Items"
        badgeTone="warning"
        items={(topPurchased.data ?? []).slice(0, 5).map((r) => ({
          id: r.item_id,
          name: r.name,
          value: formatQtyValue(r.total_qty, r.total_value),
        }))}
        loading={topPurchased.isLoading}
        skeletonRows={3}
        headerAction={
          <a href="#/inward" className="text-xs text-muted-foreground hover:text-foreground">
            View all
          </a>
        }
        emptyState={{
          icon: <ArrowDownToLine />,
          title: "No purchases in this range",
          description: "Top items purchased will appear here.",
        }}
      />
    </div>
  );
}

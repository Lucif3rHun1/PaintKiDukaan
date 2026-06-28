import { useState } from "react";
import {
  ArrowDownToLine,
  Banknote,
  PackageOpen,
  Receipt,
  ShoppingCart,
  TrendingUp,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Card, EmptyState, MetricCard, Money, PeriodDropdown, Skeleton } from "../../../components/ui";
import { SkeletonRow } from "../../../components/ui/SkeletonRow";
import {
  deadStock,
  inventoryAging,
  stockHealthSummary,
  stockReport,
  topItemsPurchased,
  topItemsSold,
} from "../../../pos/api";
import { listItems } from "../../../domain/items/api";
import { formatDateForDisplay, todayLocalYyyymmdd, shiftDaysLocal } from "../../../lib/date";
import { Donut } from "./shared";

const STAGGER_INVENTORY = 32_000;

export function InventoryTab() {
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
    queryFn: () => listItems({ low_stock_only: true, limit: 10 }),
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
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          icon={PackageOpen}
          label="Total Items (active)"
          loading={stockHealth.isLoading}
          tone="info"
        >
          <span className="text-2xl font-semibold tabular-nums">
            {health?.total_active_items ?? 0}
          </span>
        </MetricCard>
        <MetricCard
          icon={Banknote}
          label="Stock Value (retail)"
          loading={stockHealth.isLoading}
          tone="primary"
        >
          <Money paise={health?.retail_value_paise ?? 0} className="text-2xl font-semibold" />
        </MetricCard>
        <MetricCard
          icon={TrendingUp}
          label="Low Stock"
          loading={stockHealth.isLoading}
          tone="warning"
        >
          <span className="text-2xl font-semibold tabular-nums">
            {health?.low_count ?? 0}
          </span>
        </MetricCard>
        <MetricCard
          icon={Receipt}
          label="Zero Stock"
          loading={stockHealth.isLoading}
          tone="destructive"
        >
          <span className="text-2xl font-semibold tabular-nums">
            {health?.zero_count ?? 0}
          </span>
        </MetricCard>
      </div>

      <section className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card>
          <Card.Header>
            <h3 className="text-sm font-semibold">Stock Health</h3>
          </Card.Header>
          <Card.Body>
            {stockHealth.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : (
              <Donut
                healthy={health?.healthy_count ?? 0}
                low={health?.low_count ?? 0}
                zero={health?.zero_count ?? 0}
                negative={health?.negative_count ?? 0}
              />
            )}
          </Card.Body>
        </Card>

        <Card>
          <Card.Header className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Low Stock &amp; Reorder Alerts</h3>
            <a href="#/items" className="text-xs text-muted-foreground hover:text-foreground">
              View all
            </a>
          </Card.Header>
          <Card.Body className="p-0">
            {lowStock.isLoading ? (
              <div className="space-y-2 p-4">
                <SkeletonRow count={3} />
              </div>
            ) : (lowStock.data ?? []).length === 0 ? (
              <div className="p-6">
                <EmptyState
                  icon={PackageOpen}
                  title="All items are well-stocked."
                  description="No items below their reorder threshold."
                />
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {(lowStock.data ?? []).slice(0, 8).map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
                  >
                    <span className="truncate font-medium">{item.name}</span>
                    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${
                      item.current_qty <= 0
                        ? "bg-destructive/15 text-destructive"
                        : "bg-warning/15 text-warning"
                    }`}>
                      {item.current_qty < 0
                        ? `Negative stock (${item.current_qty})`
                        : item.current_qty === 0
                          ? "Out of stock"
                          : `${item.current_qty} / min ${item.min_stock}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card.Body>
        </Card>
      </section>

      <section className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card>
          <Card.Header className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Top Moving Items</h3>
            <div className="flex gap-1 rounded-md border border-border bg-card p-0.5 text-xs">
              <button
                type="button"
                onClick={() => undefined}
                aria-pressed={true}
                className="rounded bg-primary px-2 py-0.5 text-primary-foreground"
              >
                Top Sellers
              </button>
            </div>
          </Card.Header>
          <Card.Body className="p-0">
            {topSold.isLoading ? (
              <div className="space-y-2 p-4">
                <SkeletonRow count={3} />
              </div>
            ) : (topSold.data ?? []).length === 0 ? (
              <div className="p-6">
                <EmptyState
                  icon={ShoppingCart}
                  title="No sales in this range"
                  description="Top sellers will appear here."
                />
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {(topSold.data ?? []).slice(0, 5).map((r, i) => (
                  <li
                    key={r.item_id}
                    className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
                        {i + 1}
                      </span>
                      <span className="truncate font-medium">{r.name}</span>
                    </div>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {r.total_qty} × <Money paise={r.total_value} compact />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card.Body>
        </Card>

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

      <section className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card>
          <Card.Header>
            <h3 className="text-sm font-semibold">Dead Stock (60+ days idle)</h3>
          </Card.Header>
          <Card.Body className="p-0">
            {deadStockQuery.isLoading ? (
              <div className="space-y-2 p-4">
                <SkeletonRow count={3} />
              </div>
            ) : (deadStockQuery.data ?? []).length === 0 ? (
              <div className="p-6">
                <EmptyState
                  icon={TrendingUp}
                  title="All stock is moving"
                  description="No items without sales in the last 60 days."
                />
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {(deadStockQuery.data ?? []).slice(0, 8).map((r) => (
                  <li
                    key={r.item_id}
                    className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
                  >
                    <span className="truncate font-medium">{r.name}</span>
                    <div className="flex shrink-0 items-center gap-2 text-xs tabular-nums">
                      <span className="text-muted-foreground">{r.current_qty} units</span>
                      <span className="text-warning">
                        {r.last_sale_ms
                          ? formatDateForDisplay(new Date(r.last_sale_ms))
                          : "never"}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card.Body>
        </Card>

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

      <Card>
        <Card.Header className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Top Purchased Items</h3>
          <a href="#/inward" className="text-xs text-muted-foreground hover:text-foreground">
            View all
          </a>
        </Card.Header>
        <Card.Body className="p-0">
          {topPurchased.isLoading ? (
            <div className="space-y-2 p-4">
              <SkeletonRow count={3} />
            </div>
          ) : (topPurchased.data ?? []).length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={ArrowDownToLine}
                title="No purchases in this range"
                description="Top items purchased will appear here."
              />
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {(topPurchased.data ?? []).slice(0, 5).map((r, i) => (
                <li
                  key={r.item_id}
                  className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-warning/10 text-xs font-medium text-warning">
                      {i + 1}
                    </span>
                    <span className="truncate font-medium">{r.name}</span>
                  </div>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {r.total_qty} × <Money paise={r.total_value} compact />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card.Body>
      </Card>
    </div>
  );
}

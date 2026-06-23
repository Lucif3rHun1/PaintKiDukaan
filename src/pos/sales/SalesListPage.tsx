// Sales list page — recent sales with search, date filter, and pagination.

import { useMemo, useState } from "react";
import { Plus, Receipt } from "lucide-react";

import {
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
import { listSales } from "../api";
import { usePaginatedQuery } from "../../lib/query";
import { formatDateForDisplay } from "../../lib/date";
import type { Sale } from "../types";

interface Props {
  onCreate: () => void;
}

const PAGE_SIZE = 25;

export function SalesListPage({ onCreate }: Props) {
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
        (sale.customer_name ?? "walk-in").toLowerCase().includes(term) ||
        (sale.status ?? "").toLowerCase().includes(term)
      );
    },
  });

  const columns = useMemo<ColumnDef<Sale>[]>(
    () => [
      {
        header: "No",
        cell: (s) => (
          <span className="font-mono tabular-nums text-foreground">
            {s.no}
          </span>
        ),
      },
      {
        header: "Date",
        cell: (s) => (
          <span className="text-foreground">
            {formatDateForDisplay(s.date)}
          </span>
        ),
      },
      {
        header: "Status",
        cell: (s) => {
          const variant = s.status === "final" ? "success" : "info";
          return (
            <Badge variant={variant} size="sm">
              {s.status}
            </Badge>
          );
        },
      },
      {
        header: "Customer",
        cell: (s) => (
          <span className="text-foreground">
            {s.customer_name ?? "Walk-in"}
          </span>
        ),
      },
      {
        header: "Total",
        align: "right",
        cell: (s) => <Money paise={s.total} />,
      },
      {
        header: "Paid",
        align: "right",
        cell: (s) => <Money paise={s.paid_amount} />,
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Sales
          </h1>
          <p className="text-sm text-muted-foreground">
            {totalItems} {totalItems === 1 ? "sale" : "sales"}
            {search ? ` matching "${search}"` : ""}
          </p>
        </div>
        <Button
          type="button"
          variant="primary"
          size="md"
          icon={Plus}
          onClick={onCreate}
        >
          New Sale
        </Button>
      </header>

      <Card>
        <Card.Body className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search by invoice, customer, status…"
              ariaLabel="Search sales"
              className="min-w-[220px] flex-1"
            />
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
              From
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="input px-2 py-1 text-sm"
              />
            </label>
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
              To
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="input px-2 py-1 text-sm"
              />
            </label>
          </div>

          <DataTable
            data={rows}
            columns={columns}
            keyExtractor={(s) => s.id}
            loading={isLoading || isFetching}
            error={error}
            onRetry={refetch}
            emptyState={
              <EmptyState
                icon={Receipt}
                title={search ? "No matches" : "No sales yet"}
                description={
                  search
                    ? `Nothing matches "${search}". Try a different search.`
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

          {!isLoading && allData.length > 0 ? (
            <PaginationControls
              page={page}
              totalPages={totalPages}
              totalItems={totalItems}
              pageSize={pageSize}
              onPageChange={setPage}
            />
          ) : null}
        </Card.Body>
      </Card>
    </div>
  );
}

/**
 * CustomerList — searchable list with flag indicator + role-gated actions.
 * Uses canonical SearchInput, DataTable, PaginationControls, and usePaginatedQuery.
 */
import { useMemo } from "react";
import { UserPlus, Flag, Phone, Banknote } from "lucide-react";

import {
  Alert,
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
import { toast } from "../../lib/feedback/toast";
import { listCustomers } from "./api";
import { usePaginatedQuery } from "../../lib/query";
import type { Customer } from "../types";
import { extractError } from "../../lib/extractError";

interface Props {
  onSelect?: (c: Customer) => void;
  onCreate?: () => void;
  onRecordPayment?: (c: Customer) => void;
  refreshKey?: number;
  role: "owner" | "cashier" | "stocker";
}

const PAGE_SIZE = 25;

export function CustomerList({
  onSelect,
  onCreate,
  onRecordPayment,
  refreshKey,
  role,
}: Props) {
  const canCreate = onCreate && (role === "owner" || role === "cashier");
  const canPay = (role === "owner" || role === "cashier") && onRecordPayment;

  const {
    data: items,
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
  } = usePaginatedQuery<Customer>({
    queryKey: ["customers", refreshKey ?? 0],
    pageSize: PAGE_SIZE,
    queryFn: ({ search: debouncedSearch }) =>
      listCustomers(debouncedSearch || undefined),
  });

  function handlePay(c: Customer) {
    if (onRecordPayment) {
      onRecordPayment(c);
      return;
    }
    toast.info(`No payment handler available for ${c.name}`);
  }

  const columns = useMemo<ColumnDef<Customer>[]>(() => {
    const cols: ColumnDef<Customer>[] = [
      {
        header: "Name",
        cell: (c) => (
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground">{c.name}</span>
              {c.is_flagged ? (
                <Badge variant="danger" size="sm">
                  <Flag className="h-3 w-3" />
                  Flagged
                </Badge>
              ) : null}
            </div>
            {c.email ? (
              <div className="mt-0.5 truncate text-xs text-muted-foreground">
                {c.email}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        header: "Phone",
        cell: (c) =>
          c.phone ? (
            <span className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
              <Phone className="h-3 w-3" />
              {c.phone}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        header: "Type",
        cell: (c) => (
          <span className="text-muted-foreground">
            {c.type_name ?? "—"}
          </span>
        ),
      },
      {
        header: "Status",
        cell: (c) =>
          !c.is_active ? (
            <Badge variant="muted" size="sm">
              Inactive
            </Badge>
          ) : (
            <Badge variant="success" size="sm">
              Active
            </Badge>
          ),
      },
      {
        header: "Credit",
        align: "right",
        cell: (c) =>
          c.credit_limit != null ? (
            <Money paise={c.credit_limit} />
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        header: "Opening",
        align: "right",
        cell: (c) => <Money paise={c.opening_balance_paise} muted />,
      },
    ];

    if (canPay) {
      cols.push({
        header: "Action",
        align: "right",
        cell: (c) => (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            icon={Banknote}
            onClick={() => handlePay(c)}
          >
            Pay
          </Button>
        ),
      });
    }

    return cols;
  }, [canPay]);

  const rowClassName = (c: Customer) => (c.is_active ? "" : "opacity-60");

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-2xl font-semibold tracking-tight">Customers</h2>
          <p className="text-sm text-muted-foreground">
            {totalItems} {totalItems === 1 ? "customer" : "customers"}
            {search ? ` matching "${search}"` : ""}
          </p>
        </div>
        {canCreate ? (
          <Button
            type="button"
            variant="primary"
            size="md"
            icon={UserPlus}
            onClick={onCreate}
          >
            New Customer
          </Button>
        ) : null}
      </header>

      <Card>
        <Card.Body className="space-y-3">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search by name or phone…"
            ariaLabel="Search customers"
          />

          {error ? (
            <Alert title="Could not load customers" variant="destructive">
              {extractError(error)}
            </Alert>
          ) : null}

          <DataTable
            data={items}
            columns={columns}
            keyExtractor={(c) => c.id}
            loading={isLoading || isFetching}
            emptyState={
              <EmptyState
                icon={UserPlus}
                title={search ? "No matches" : "No customers yet"}
                description={
                  search
                    ? `Nothing matches "${search}". Try a different search.`
                    : "Add the first customer to start recording sales and credit."
                }
                primary={
                  canCreate ? (
                    <Button
                      type="button"
                      onClick={onCreate}
                      icon={UserPlus}
                    >
                      Add Customer
                    </Button>
                  ) : undefined
                }
              />
            }
            error={error}
            onRetry={refetch}
            onRowClick={onSelect ? (c) => onSelect(c) : undefined}
            rowClassName={rowClassName}
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

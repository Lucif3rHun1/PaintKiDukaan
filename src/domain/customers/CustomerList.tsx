/**
 * CustomerList — searchable list with flag indicator + role-gated actions.
 * Renders via <DataList> server source (cmd_list_customers_paged).
 */
import { useMemo } from "react";
import { Flag, Phone, UserPlus, Banknote } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { Badge, Button, Card, DataList, EmptyState, Money } from '../../components/ui';
import type { ColumnDef } from "../../components/ui";
import { toast } from "../../lib/feedback/toast";
import { listCustomersPaged, listCustomerMetrics } from "./api";
import type { Customer } from "../types";
import { useShortcut } from "../../lib/shortcuts";
import { toTitleCase } from "../../lib/format/titleCase";
import { useFocusShortcut } from "../../lib/shortcuts/useFocusShortcut";

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

  const customerMetrics = useQuery({
    queryKey: ["list-metrics", "cmd_customer_metrics"],
    queryFn: listCustomerMetrics,
  });

  const serverSource = useMemo(() => ({
    endpoint: "cmd_list_customers_paged",
    pageSize: PAGE_SIZE,
    initialSort: { field: "name", dir: "asc" as const },
    clientFn: listCustomersPaged,
  }), [refreshKey]);

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
        id: "name",
        header: "Name",
        cell: (c) => (
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground">{toTitleCase(c.name)}</span>
              {c.is_flagged ? (
                <Badge variant="warning" size="sm">
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
        sortField: "name",
        sortable: true,
        searchable: true,
      },
      {
        id: "phone",
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
        sortField: "phone",
        sortable: true,
      },
      {
        id: "type",
        header: "Type",
        cell: (c) => (
          <span className="text-muted-foreground">
            {c.type_name ?? "—"}
          </span>
        ),
      },
      {
        id: "status",
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
        id: "credit",
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
        id: "opening",
        header: "Opening",
        align: "right",
        cell: (c) => <Money paise={c.opening_balance_paise} muted />,
        sortField: "opening_balance_paise",
        sortable: true,
      },
    ];

    if (canPay) {
      cols.push({
        id: "action",
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

  useFocusShortcut({ key: "F2", selector: '[data-shortcut="search"]', description: "Focus search" });
  useShortcut({
    key: "F5",
    scope: "page",
    description: "Refresh list",
    onMatch: () => {
      void customerMetrics.refetch();
    },
  });
  useShortcut({
    key: "F6",
    scope: "page",
    description: "New customer",
    onMatch: () => {
      if (canCreate && onCreate) onCreate();
    },
  });

  return (
    <div className="space-y-3">
      {/* ── Metric cards ─────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card as="section" className="space-y-1 p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Total</p>
          <p className="text-2xl font-semibold tabular-nums text-foreground">{customerMetrics.data?.total ?? "—"}</p>
        </Card>
        <Card as="section" className="space-y-1 p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Active</p>
          <p className="text-2xl font-semibold tabular-nums text-success">{customerMetrics.data?.active ?? "—"}</p>
        </Card>
        <Card as="section" className="space-y-1 p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Inactive</p>
          <p className="text-2xl font-semibold tabular-nums text-muted-foreground">{customerMetrics.data?.inactive ?? "—"}</p>
        </Card>
        <Card
          as="section"
          className={
            (customerMetrics.data?.flagged ?? 0) > 0
              ? "space-y-1 border-warning/40 bg-warning/5 p-4"
              : "space-y-1 p-4"
          }
        >
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Flagged</p>
          <p className={`text-2xl font-semibold tabular-nums ${(customerMetrics.data?.flagged ?? 0) > 0 ? "text-warning" : "text-foreground"}`}>
            {customerMetrics.data?.flagged ?? "—"}
          </p>
        </Card>
      </div>

      <DataList
        source={serverSource}
        columns={columns}
        keyExtractor={(c) => c.id}
        searchPlaceholder="Search by name or phone…"
        emptyState={({ hasActiveFilter }) => (
          <EmptyState
            icon={UserPlus}
            title={hasActiveFilter ? "No matches" : "No customers yet"}
            description={
              hasActiveFilter
                ? "Nothing matches your search. Try a different query."
                : "Add the first customer to start recording sales and credit."
            }
            primary={
              canCreate ? (
                <Button type="button" onClick={onCreate} icon={UserPlus}>
                  Add Customer
                </Button>
              ) : undefined
            }
          />
        )}
        onRowClick={onSelect ? (c) => onSelect(c) : undefined}
        rowClassName={rowClassName}
        actions={
          canCreate ? (
            <Button type="button" variant="primary" size="sm" icon={UserPlus} onClick={onCreate} shortcut="F6">
              New Customer
            </Button>
          ) : null
        }
        height={400}
      />
    </div>
  );
}
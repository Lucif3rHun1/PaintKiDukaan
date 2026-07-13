/**
 * CustomerList — searchable list with flag indicator + role-gated actions.
 * Renders via <DataList> server source (cmd_list_customers_paged).
 */
import { useCallback, useMemo, useState } from "react";
import { Archive, Flag, Phone, UserPlus, Banknote } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { ActionMenu, Badge, Button, Card, DataList, EmptyState, Money } from '../../components/ui';
import type { ColumnDef } from "../../components/ui";
import { ConfirmDialog } from "../../shell/components/ConfirmDialog";
import { toast } from "../../lib/feedback/toast";
import { extractError } from "../../lib/extractError";
import { listCustomersPaged, listCustomerMetrics, updateCustomer } from "./api";
import type { Customer } from "../types";
import { useShortcut } from "../../lib/shortcuts";
import { toTitleCase } from "../../lib/format/titleCase";
import { useFocusShortcut } from "../../lib/shortcuts/useFocusShortcut";
import { Skeleton } from "boneyard-js/react";

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
  const canEdit = role === "owner";
  const queryClient = useQueryClient();
  const [archiveConfirmCustomer, setArchiveConfirmCustomer] = useState<Customer | null>(null);

  const customerMetrics = useQuery({
    queryKey: ["list-metrics", "cmd_customer_metrics"],
    queryFn: listCustomerMetrics,
  });

  const handleArchive = useCallback(async (customer: Customer) => {
    try {
      await updateCustomer(customer.id, { is_active: !customer.is_active });
      toast.success(customer.is_active ? "Archived" : "Restored");
      void queryClient.invalidateQueries({ queryKey: ["list", "cmd_list_customers_paged"] });
      void customerMetrics.refetch();
    } catch (e) {
      toast.error(extractError(e));
    }
  }, [queryClient, customerMetrics]);

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
        flex: true,
        minWidth: "12rem",
        maxWidth: "16rem",
        cell: (c) => (
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium text-foreground" title={toTitleCase(c.name)}>{toTitleCase(c.name)}</span>
              {c.is_flagged ? (
                <Badge variant="warning" size="sm">
                  <Flag className="h-3 w-3" />
                  Flagged
                </Badge>
              ) : null}
            </div>
            {c.email ? (
              <div className="mt-0.5 truncate text-xs text-muted-foreground" title={c.email}>
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
        width: "8rem",
        cell: (c) =>
          c.phone ? (
            <span className="inline-flex items-center gap-1 truncate font-mono text-xs text-muted-foreground" title={c.phone}>
              <Phone className="h-3 w-3 shrink-0" />
              <span className="truncate">{c.phone}</span>
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
        width: "8rem",
        cell: (c) => (
          <span className="truncate text-muted-foreground" title={c.type_name ?? ""}>
            {c.type_name ?? "—"}
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        width: "6rem",
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
        width: "7rem",
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
        width: "8rem",
        align: "right",
        cell: (c) => <Money paise={c.opening_balance_paise} muted />,
        sortField: "opening_balance_paise",
        sortable: true,
      },
    ];

    if (canEdit) {
      cols.push({
        id: "actions",
        header: "",
        width: "3.5rem",
        align: "right",
        cell: (c) => (
          <ActionMenu
            label={`Actions for ${c.name}`}
            items={[
              { label: c.is_active ? "Archive" : "Restore", icon: Archive, danger: c.is_active, onSelect: () => setArchiveConfirmCustomer(c) },
            ]}
          />
        ),
      });
    }

    if (canPay) {
      cols.push({
        id: "action",
        header: "",
        width: "5rem",
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
  }, [canPay, canEdit]);

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
  <Skeleton name="customers-list" loading={customerMetrics.isLoading} select="viewport">
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
        fill
      />

      <ConfirmDialog
        open={archiveConfirmCustomer !== null}
        title={archiveConfirmCustomer?.is_active ? "Archive this customer?" : "Restore this customer?"}
        body={archiveConfirmCustomer?.is_active ? `${archiveConfirmCustomer.name} will be hidden from search. Existing records are kept.` : `${archiveConfirmCustomer?.name} will be visible again.`}
        confirmLabel={archiveConfirmCustomer?.is_active ? "Archive" : "Restore"}
        destructive={archiveConfirmCustomer?.is_active ?? false}
        onConfirm={() => { if (archiveConfirmCustomer) { void handleArchive(archiveConfirmCustomer); setArchiveConfirmCustomer(null); } }}
        onCancel={() => setArchiveConfirmCustomer(null)}
      />
    </div>
  </Skeleton>
  );
}
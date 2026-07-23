import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Archive, Edit3, Copy } from "lucide-react";
import { ActionMenu } from "../../components/ui/ActionMenu";
import { useQueryClient } from "@tanstack/react-query";

import {
  Badge,
  Button,
  Card,
  DataList,
  EmptyState,
  InlineDialog,
  Money,
} from "../../components/ui";
import type { ColumnDef } from "../../components/ui";
import { ConfirmDialog } from "../../shell/components/ConfirmDialog";
import { formatDateForDisplay } from "../../lib/date";
import { toast } from "../../lib/feedback/toast";
import { extractError } from "../../lib/extractError";
import {
  deactivateFormula,
  getFormula,
  listFormulaSalesPaged,
} from "./api";
import { setHash } from "../../lib/navigate";
import type { Formula } from "./api";
import { FormulaForm } from "./FormulaForm";
import { invalidateList, invalidateListMetrics } from "../../lib/query";
import { Skeleton } from "boneyard-js/react";

interface Props {
  id: number;
  role: "owner" | "cashier" | "stocker";
  onBack: () => void;
}

export function FormulaDetailsPage({ id, role, onBack }: Props) {
  const queryClient = useQueryClient();
  const canEdit = role === "owner";
  const [formula, setFormula] = useState<Formula | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const salesServerSource = useMemo(() => ({
    endpoint: "cmd_list_formula_sales_paged",
    pageSize: 50,
    initialSort: { field: "sold_at", dir: "desc" as const },
    filters: { formula_id: id, from_date: fromDate || undefined, to_date: toDate || undefined },
    clientFn: listFormulaSalesPaged,
  }), [id, fromDate, toDate]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const f = await getFormula(id);
      setFormula(f);
    } catch (e) {
      setError(extractError(e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleArchive = useCallback(async () => {
    try {
      await toast.promise(deactivateFormula(id), {
        loading: "Archiving…",
        success: "Archived",
        error: (e) => extractError(e),
      });
      void invalidateList(queryClient, "cmd_list_formulas_paged");
      void invalidateListMetrics(queryClient, "cmd_formula_metrics");
      setConfirmArchive(false);
      void load();
    } catch {
      /* toast handles */
    }
  }, [id, load, queryClient]);

  const handleSaved = useCallback(
    (saved: Formula) => {
      toast.success(`Saved ${saved.id_code}`);
      setEditing(false);
      setFormula(saved);
      void invalidateList(queryClient, "cmd_list_formulas_paged");
      void invalidateListMetrics(queryClient, "cmd_formula_metrics");
    },
    [queryClient],
  );

  const salesColumns: ColumnDef<{
    sale_id: number;
    sale_no: string;
    sale_kind: string;
    date: string;
    customer_name: string | null;
    price: number;
    line_total: number;
  }>[] = [
    {
      id: "sale_no",
      header: "Invoice",
      width: "12rem",
      cell: (row) => (
        <span className="font-mono text-xs tabular-nums text-foreground">
          {row.sale_no}
          {row.sale_kind === "quotation" ? (
            <Badge variant="info" size="sm" className="ml-1">Qtn</Badge>
          ) : null}
        </span>
      ),
      sortField: "sale_no",
      sortable: true,
    },
    {
      id: "date",
      header: "Date",
      width: "7rem",
      cell: (row) => (
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {formatDateForDisplay(row.date)}
        </span>
      ),
      sortField: "date",
      sortable: true,
    },
    {
      id: "customer",
      header: "Customer",
      flex: true,
      minWidth: "10rem",
      maxWidth: "16rem",
      cell: (row) => (
        <span className="truncate text-foreground">
          {row.customer_name ?? <span className="text-muted-foreground">Walk-in</span>}
        </span>
      ),
      searchable: true,
    },
    {
      id: "price",
      header: "Price",
      width: "7rem",
      align: "right",
      cell: (row) => <Money paise={row.price} />,
      sortField: "price",
      sortable: true,
    },
    {
      id: "line_total",
      header: "Total",
      width: "7rem",
      align: "right",
      cell: (row) => <Money paise={row.line_total} />,
      sortField: "line_total",
      sortable: true,
    },
  ];

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        Loading formula…
      </div>
    );
  }

  if (error || !formula) {
    return (
      <div className="space-y-4">
        <header className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack}>
            Formulas
          </Button>
        </header>
        <EmptyState
          title="Formula not found"
          description={error ?? `Formula #${id} could not be loaded.`}
          primary={
            <Button type="button" onClick={onBack}>
              Back to formulas
            </Button>
          }
        />
      </div>
    );
  }

  return (
  <Skeleton name="formula-detail" loading={loading} select="viewport">
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack}>
            Formulas
          </Button>
          <h1 className="text-base font-semibold text-foreground">
            <span className="font-mono tabular-nums">{formula.id_code}</span>
            {formula.name ? (
              <span className="ml-2 text-muted-foreground">— {formula.name}</span>
            ) : null}
          </h1>
          {formula.is_active ? (
            <Badge variant="success" size="sm">Active</Badge>
          ) : (
            <Badge variant="muted" size="sm">Inactive</Badge>
          )}
        </div>
        {canEdit ? (
          <ActionMenu
            label="Formula actions"
            items={[
              {
                label: "Edit",
                icon: Edit3,
                onClick: () => setEditing(true),
              },
              {
                label: "Copy shade ID",
                icon: Copy,
                onClick: async () => {
                  try {
                    await navigator.clipboard.writeText(formula.id_code);
                    toast.success(`Copied ${formula.id_code}`);
                  } catch {
                    toast.error("Failed to copy — clipboard not available");
                  }
                },
              },
              ...(formula.is_active
                ? [
                    {
                      label: "Archive",
                      icon: Archive,
                      danger: true as const,
                      onClick: () => setConfirmArchive(true),
                    },
                  ]
                : []),
            ]}
          />
        ) : null}
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <Card as="section" depth="flat" className="space-y-3 p-4">
          <h2 className="text-sm font-semibold text-foreground">Details</h2>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Row label="Shade ID">
              <span className="font-mono">{formula.id_code}</span>
            </Row>
            <Row label="Name">
              {formula.name ?? <span className="text-muted-foreground">—</span>}
            </Row>
            <Row label="Base">
              {formula.with_base
                ? formula.base_item_name
                  ? `With base (${formula.base_item_name})`
                  : "With base"
                : "No base"}
            </Row>
            <Row label="Price">
              <Money paise={formula.retail_price_paise} />
            </Row>
            <Row label="Sales count">
              <span className="tabular-nums">{formula.sales_count}</span>
            </Row>
            <Row label="Last sold">
              {formula.last_sold_at ? formatDateForDisplay(formula.last_sold_at) : "Never"}
            </Row>
            <Row label="Created">
              <span className="tabular-nums whitespace-nowrap">{formatDateForDisplay(formula.created_at)}</span>
            </Row>
          </dl>
        </Card>

        <Card as="section" depth="flat" className="space-y-3 p-4">
          <h2 className="text-sm font-semibold text-foreground">Sales</h2>
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">From</span>
                <input
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="input"
                />
              </label>
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">To</span>
                <input
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                  className="input"
                />
              </label>
            </div>
          </div>

          <DataList
            source={salesServerSource}
            columns={salesColumns}
            keyExtractor={(row) => row.sale_id}
            searchPlaceholder="Search invoice or customer…"
            emptyMessage="No sales match the filters."
            onRowClick={(row) => (setHash(`#/sales/${row.sale_id}`))}
            height={300}
          />
        </Card>
      </div>

      <InlineDialog
        open={editing}
        onClose={() => setEditing(false)}
        title="Edit formula"
        size="md"
      >
        <FormulaForm
          mode="edit"
          initial={formula}
          onSaved={handleSaved}
          onCancel={() => setEditing(false)}
        />
      </InlineDialog>

      <ConfirmDialog
        open={confirmArchive}
        title="Archive formula?"
        body={`${formula.id_code} will be hidden from the sales page search. Existing invoices keep the line.`}
        confirmLabel="Archive"
        destructive
        onConfirm={() => void handleArchive()}
        onCancel={() => setConfirmArchive(false)}
      />
    </div>
  </Skeleton>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-foreground">{children}</dd>
    </div>
  );
}

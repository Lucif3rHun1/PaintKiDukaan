import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Archive, Edit3, Copy, MoreHorizontal } from "lucide-react";
import { ActionMenu } from "../../components/ui/ActionMenu";
import { useQueryClient } from "@tanstack/react-query";

import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  InlineDialog,
  Money,
  SearchInput,
  Skeleton,
} from "../../components/ui";
import { ConfirmDialog } from "../../shell/components/ConfirmDialog";
import { formatDateForDisplay } from "../../lib/date";
import { toast } from "../../lib/feedback/toast";
import { extractError } from "../../lib/extractError";
import {
  deactivateFormula,
  getFormula,
  listFormulaSales,
} from "./api";
import type { Formula, FormulaSaleRow } from "./api";
import { FormulaForm } from "./FormulaForm";

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

  const [history, setHistory] = useState<FormulaSaleRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

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

  useEffect(() => {
    let cancelled = false;
    setHistoryLoading(true);
    setHistoryError(null);
    listFormulaSales(id, {
      query: query || undefined,
      from_date: fromDate || undefined,
      to_date: toDate || undefined,
    })
      .then((rows) => {
        if (cancelled) return;
        setHistory(rows);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setHistoryError(extractError(e));
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, query, fromDate, toDate]);

  const handleArchive = useCallback(async () => {
    try {
      await toast.promise(deactivateFormula(id), {
        loading: "Archiving…",
        success: "Archived",
        error: (e) => extractError(e),
      });
      queryClient.invalidateQueries({ queryKey: ["formulas"] });
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
      queryClient.invalidateQueries({ queryKey: ["formulas"] });
    },
    [queryClient],
  );

  const historyTotal = useMemo(
    () => history.reduce((sum, r) => sum + r.line_total, 0),
    [history],
  );

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
                onClick: () => {
                  void navigator.clipboard.writeText(formula.id_code);
                  toast.success(`Copied ${formula.id_code}`);
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
        <Card as="section" className="space-y-3 p-4">
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
              {formatDateForDisplay(formula.created_at)}
            </Row>
          </dl>
        </Card>

        <Card as="section" className="space-y-3 p-4">
          <h2 className="text-sm font-semibold text-foreground">Sales</h2>
          <div className="space-y-2">
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="Search invoice or customer…"
              ariaLabel="Search history"
            />
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

          {historyError ? (
            <Alert title="History failed to load">{historyError}</Alert>
          ) : null}
          {historyLoading ? <Skeleton variant="card" className="h-32" /> : null}
          {!historyLoading && history.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No sales match the filters.
            </p>
          ) : null}
          {!historyLoading && history.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-2">Invoice</th>
                    <th>Date</th>
                    <th>Customer</th>
                    <th className="text-right">Price</th>
                    <th className="text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((row) => (
                    <tr
                      key={row.sale_id}
                      onClick={() => (window.location.hash = `#/sales/${row.sale_id}`)}
                      className="cursor-pointer border-b border-border transition-colors hover:bg-muted"
                    >
                      <td className="py-2 font-mono text-xs tabular-nums text-foreground">
                        {row.sale_no}
                        {row.sale_kind === "quotation" ? (
                          <Badge variant="info" size="sm" className="ml-1">Qtn</Badge>
                        ) : null}
                      </td>
                      <td className="py-2 text-xs text-muted-foreground">
                        {formatDateForDisplay(row.date)}
                      </td>
                      <td className="py-2 text-foreground">
                        {row.customer_name ?? <span className="text-muted-foreground">Walk-in</span>}
                      </td>
                      <td className="py-2 text-right">
                        <Money paise={row.price} />
                      </td>
                      <td className="py-2 text-right">
                        <Money paise={row.line_total} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-2 flex justify-end text-xs text-muted-foreground">
                Total: <Money paise={historyTotal} className="ml-1 font-medium text-foreground" />
              </div>
            </div>
          ) : null}
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
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-foreground">{children}</dd>
    </div>
  );
}

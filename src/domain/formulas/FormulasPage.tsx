import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { useQueryClient, useQuery } from "@tanstack/react-query";

import {
  Badge,
  Button,
  DataList,
  EmptyState,
  Money,
} from "../../components/ui";
import type { ColumnDef } from "../../components/ui";
import { formatDateForDisplay } from "../../lib/date";
import { toast } from "../../lib/feedback/toast";
import { useShortcut } from "../../lib/shortcuts";
import { setHash } from "../../lib/navigate";
import { useFocusShortcut } from "../../lib/shortcuts/useFocusShortcut";
import { invalidateList, invalidateListMetrics } from "../../lib/query";
import { listFormulasPaged, listFormulaMetrics } from "./api";
import type { Formula } from "./api";
import { FormulaForm } from "./FormulaForm";
import { useMemo } from "react";

type Mode = "list" | "create";
type Filter = "all" | "active" | "inactive";

interface Props {
  role: "owner" | "cashier" | "stocker";
}

const PAGE_SIZE = 50;

export function FormulasPage({ role }: Props) {
  const queryClient = useQueryClient();
  const canEdit = role === "owner";
  const [mode, setMode] = useState<Mode>("list");
  const [filter, setFilter] = useState<Filter>(readFilterFromHash);

  const formulaMetrics = useQuery({
    queryKey: ["list-metrics", "cmd_formula_metrics"],
    queryFn: listFormulaMetrics,
  });

  const serverSource = useMemo(() => ({
    endpoint: "cmd_list_formulas_paged",
    pageSize: PAGE_SIZE,
    initialSort: { field: "id_code", dir: "asc" as const },
    filters: { active: filter === "all" ? undefined : filter === "active" },
    clientFn: listFormulasPaged,
  }), [filter]);

  useEffect(() => {
    writeFilterToHash(filter);
  }, [filter]);

  useEffect(() => {
    const onHash = () => setFilter(readFilterFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useFocusShortcut({ key: "F2", selector: '[data-shortcut="search"]', description: "Focus search" });
  useShortcut({
    key: "F5",
    scope: "page",
    description: "Refresh list",
    onMatch: () => {
      if (mode === "list") void formulaMetrics.refetch();
    },
  });
  useShortcut({
    key: "F6",
    scope: "page",
    description: "New formula",
    onMatch: () => {
      if (mode === "list" && canEdit) setMode("create");
    },
  });

  const handleSaved = useCallback(
    (saved: Formula) => {
      toast.success(`Saved ${saved.id_code}`);
      setMode("list");
      queryClient.invalidateQueries({ queryKey: ["formulas"] });
      void invalidateList(queryClient, "cmd_list_formulas_paged");
      void invalidateListMetrics(queryClient, "cmd_formula_metrics");
    },
    [queryClient],
  );

  if (mode === "create" && canEdit) {
    return (
      <FormulaForm
        mode="create"
        onSaved={handleSaved}
        onCancel={() => setMode("list")}
      />
    );
  }

  const formulaColumns: ColumnDef<Formula>[] = [
    {
      id: "id_code",
      header: "Shade ID",
      width: "8rem",
      cell: (f) => <span className="font-mono tabular-nums text-foreground">{f.id_code}</span>,
      sortField: "id_code",
      sortable: true,
    },
    {
      id: "name",
      header: "Name",
      flex: true,
      minWidth: "12rem",
      maxWidth: "20rem",
      cell: (f) => f.name ? <span className="truncate text-foreground">{f.name}</span> : <span className="text-muted-foreground">—</span>,
      sortField: "name",
      sortable: true,
      searchable: true,
    },
    {
      id: "base",
      header: "Base",
      width: "10rem",
      cell: (f) => (
        <span className="truncate text-muted-foreground">
          {f.with_base ? f.base_item_name ?? "With base" : "—"}
        </span>
      ),
    },
    {
      id: "retail_price",
      header: "Price",
      width: "7rem",
      align: "right",
      cell: (f) => <Money paise={f.retail_price_paise} />,
    },
    {
      id: "sales_count",
      header: "Sales",
      width: "5rem",
      align: "right",
      cell: (f) => <span className="tabular-nums text-muted-foreground">{f.sales_count}</span>,
      sortField: "sales_count",
      sortable: true,
    },
    {
      id: "last_sold_at",
      header: "Last sold",
      width: "8rem",
      cell: (f) => (
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {f.last_sold_at ? formatDateForDisplay(f.last_sold_at) : "—"}
        </span>
      ),
      sortField: "last_sold_at",
      sortable: true,
    },
    {
      id: "is_active",
      header: "Status",
      width: "6rem",
      align: "center",
      cell: (f) =>
        f.is_active ? (
          <Badge variant="success" size="sm">Active</Badge>
        ) : (
          <Badge variant="muted" size="sm">Inactive</Badge>
        ),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="radiogroup"
          aria-label="Filter by status"
          className="inline-flex rounded-md border border-border bg-card p-0.5 text-sm"
        >
          {(["all", "active", "inactive"] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={filter === f}
              onClick={() => setFilter(f)}
              className={
                filter === f
                  ? "rounded bg-primary px-3 py-1 font-medium text-primary-foreground"
                  : "rounded px-3 py-1 font-medium text-muted-foreground hover:text-foreground"
              }
            >
              {f === "all" ? "All" : f === "active" ? "Active" : "Inactive"}
            </button>
          ))}
        </div>
        {canEdit ? (
          <Button
            type="button"
            size="sm"
            icon={Plus}
            onClick={() => setMode("create")}
            shortcut="F6"
          >
            New formula
          </Button>
        ) : null}
      </div>

      <DataList
        source={serverSource}
        columns={formulaColumns}
        keyExtractor={(f) => f.id}
        searchPlaceholder="Search by shade ID or name…"
        emptyMessage="No formulas match this view"
        emptyCta={
          <EmptyState
            icon={Plus}
            title="No formulas match this view"
            description={
              canEdit
                ? "Create a shade mix — each formula gets a unique ID like 8827 that cashiers search at the counter."
                : "Add a formula in Settings or ask an owner."
            }
            primary={
              canEdit ? (
                <Button type="button" onClick={() => setMode("create")}>New formula</Button>
              ) : undefined
            }
          />
        }
        onRowClick={(f) => (setHash(`#/formulas/${f.id}`))}
        headerMetrics={
          formulaMetrics.data ? (
            <div className="flex gap-3 text-xs text-muted-foreground">
              <span>Total: <strong className="text-foreground">{formulaMetrics.data.total}</strong></span>
              <span>Active: <strong className="text-success">{formulaMetrics.data.active}</strong></span>
              <span>Inactive: <strong className="text-muted-foreground">{formulaMetrics.data.inactive}</strong></span>
            </div>
          ) : undefined
        }
        height={400}
      />
    </div>
  );
}

function readFilterFromHash(): Filter {
  if (typeof window === "undefined") return "all";
  const m = window.location.hash.match(/[?&]filter=([a-z]+)/);
  if (m && (m[1] === "active" || m[1] === "inactive" || m[1] === "all")) {
    return m[1] as Filter;
  }
  return "all";
}

function writeFilterToHash(filter: Filter) {
  if (typeof window === "undefined") return;
  const base = window.location.hash.split("?")[0] || "#/formulas";
  const next = `${base}?filter=${filter}`;
  if (window.location.hash !== next) {
    window.history.replaceState(null, "", next);
  }
}
import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import {
  Alert,
  Badge,
  Button,
  EmptyState,
  InlineDialog,
  Money,
  SearchInput,
  Skeleton,
} from "../../components/ui";
import { formatDateForDisplay } from "../../lib/date";
import { toast } from "../../lib/feedback/toast";
import { useShortcut } from "../../lib/shortcuts";
import { useFocusShortcut } from "../../lib/shortcuts/useFocusShortcut";
import { usePaginatedQuery } from "../../lib/query";
import { listFormulas } from "./api";
import type { Formula } from "./api";
import { FormulaForm } from "./FormulaForm";
import { extractError } from "../../lib/extractError";

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

  useEffect(() => {
    writeFilterToHash(filter);
  }, [filter]);

  useEffect(() => {
    const onHash = () => setFilter(readFilterFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const {
    data: formulas,
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
  } = usePaginatedQuery<Formula>({
    queryKey: ["formulas", filter],
    pageSize: PAGE_SIZE,
    queryFn: ({ search: q }) =>
      listFormulas({
        query: q || undefined,
        active: filter === "all" ? null : filter === "active",
      }),
    clientSort: (a, b) => {
      const aTime = a.last_sold_at ?? "";
      const bTime = b.last_sold_at ?? "";
      if (aTime !== bTime) return bTime.localeCompare(aTime);
      return a.id_code.localeCompare(b.id_code, undefined, { numeric: true });
    },
  });
  void pageSize;

  useFocusShortcut({ key: "F2", selector: '[data-shortcut="search"]', description: "Focus search" });
  useShortcut({
    key: "F5",
    scope: "page",
    description: "Refresh list",
    onMatch: () => {
      if (mode === "list") void refetch();
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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search by shade ID or name…"
          ariaLabel="Search formulas"
          data-shortcut="search"
        />
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

      {error ? (
        <Alert variant="destructive">{extractError(error)}</Alert>
      ) : null}
      {isLoading || isFetching ? <Skeleton variant="card" className="h-40" /> : null}

      {!isLoading && allData.length === 0 ? (
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
              <Button type="button" onClick={() => setMode("create")}>
                New formula
              </Button>
            ) : undefined
          }
        />
      ) : null}

      {!isLoading && allData.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Shade ID</th>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Base</th>
                  <th className="px-3 py-2 text-right font-medium">Price</th>
                  <th className="px-3 py-2 text-right font-medium">Sales</th>
                  <th className="px-3 py-2 font-medium">Last sold</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {formulas.map((f) => (
                  <tr
                    key={f.id}
                    onClick={() => (window.location.hash = `#/formulas/${f.id}`)}
                    className="cursor-pointer border-b border-border transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                  >
                    <td className="px-3 py-2 font-mono tabular-nums text-foreground">
                      {f.id_code}
                    </td>
                    <td className="px-3 py-2 text-foreground">
                      {f.name ? f.name : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {f.with_base
                        ? f.base_item_name ?? "With base"
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-right text-foreground">
                      <Money paise={f.retail_price_paise} />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {f.sales_count}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {f.last_sold_at ? formatDateForDisplay(f.last_sold_at) : "—"}
                    </td>
                    <td className="px-3 py-2">
                      {f.is_active ? (
                        <Badge variant="success" size="sm">Active</Badge>
                      ) : (
                        <Badge variant="muted" size="sm">Inactive</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {!isLoading && allData.length > 0 ? (
        <div className="flex items-center justify-between rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
          <span>
            Showing {formulas.length} of {totalItems}
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              Prev
            </Button>
            <span>
              Page {page} / {totalPages || 1}
            </span>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
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

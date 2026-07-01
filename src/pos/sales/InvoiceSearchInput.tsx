import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Circle, FileText, X } from "lucide-react";
import { listSales } from "../../pos/api";
import { cn } from "../../components/ui/cn";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  PaginationControls,
  SearchInput,
} from "../../components/ui";
import { formatRupeesFromPaise } from "../../lib/money";
import type { Sale } from "../types";

interface Props {
  /** Already-linked invoices shown as chips above the search; passed in so the parent owns state. */
  linked: Sale[];
  /** Called with the new combined linked list when the user confirms their selection. */
  onLink: (next: Sale[]) => void;
  /** Called when a single chip is removed. */
  onUnlink: (saleId: number) => void;
  /** Optional inline-help blurb shown when no invoices are linked yet. */
  emptyHint?: string;
  pageSize?: number;
}

function saleKey(s: Sale): string {
  return s.no;
}

export function InvoiceSearchInput({
  linked,
  onLink,
  onUnlink,
  emptyHint,
  pageSize = 20,
}: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Sale[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const seqRef = useRef(0);

  const linkedIds = useMemo(() => new Set(linked.map((s) => s.id)), [linked]);

  useEffect(() => {
    const seq = ++seqRef.current;
    setSearching(true);
    setError(null);
    const timer = window.setTimeout(async () => {
      try {
        const rows = await listSales(undefined, undefined, 200);
        if (seqRef.current !== seq) return;
        setResults(
          rows.filter(
            (r) =>
              r.status === "final" &&
              !linkedIds.has(r.id) &&
              !selectedIds.has(r.id),
          ),
        );
        setPage(1);
      } catch (e) {
        if (seqRef.current !== seq) return;
        setError(e instanceof Error ? e.message : String(e));
        setResults([]);
      } finally {
        if (seqRef.current === seq) setSearching(false);
      }
    }, 200);
    return () => window.clearTimeout(timer);
  }, [linkedIds, selectedIds]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return results;
    return results.filter(
      (r) =>
        r.no.toLowerCase().includes(q) ||
        (r.customer_name ?? "").toLowerCase().includes(q),
    );
  }, [results, query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize);

  function toggleSelect(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function confirmLink() {
    if (selectedIds.size === 0) return;
    const picked = results.filter((r) => selectedIds.has(r.id));
    const merged = [...linked];
    const seen = new Set(linked.map((s) => s.id));
    for (const sale of picked) {
      if (!seen.has(sale.id)) {
        merged.push(sale);
        seen.add(sale.id);
      }
    }
    onLink(merged);
    setSelectedIds(new Set());
    setResults((prev) => prev.filter((r) => !selectedIds.has(r.id)));
  }

  return (
    <div className="space-y-3">
      {linked.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            Linked invoices:
          </span>
          {linked.map((s) => (
            <Badge key={s.id} variant="info" size="sm" className="gap-1 pr-1">
              <FileText className="h-3 w-3" aria-hidden="true" />
              {s.no}
              <button
                type="button"
                onClick={() => onUnlink(s.id)}
                aria-label={`Unlink ${saleKey(s)}`}
                className="ml-1 rounded-full p-0.5 hover:bg-info/40"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <SearchInput
          value={query}
          onChange={setQuery}
          debounceMs={150}
          placeholder="Filter by invoice number or customer…"
          ariaLabel="Filter invoices"
          className="flex-1"
        />
        <Button
          type="button"
          onClick={confirmLink}
          disabled={selectedIds.size === 0 || searching}
        >
          Link {selectedIds.size > 0 ? `(${selectedIds.size})` : ""}
        </Button>
      </div>

      {error && <Alert variant="destructive">{error}</Alert>}

      {linked.length === 0 && emptyHint && (
        <Alert variant="info">{emptyHint}</Alert>
      )}

      {filtered.length === 0 && !searching && !error && (
        <EmptyState
          icon={FileText}
          title="No invoices found"
          description={
            linked.length === 0
              ? "Search results load below. Link 1+ invoices to scope items, or skip to use the full inventory."
              : "Try clearing the filter, or link more invoices from a different date."
          }
        />
      )}

      {pageRows.length > 0 && (
        <Card bare>
          <ul className="divide-y divide-border">
            {pageRows.map((sale) => {
              const isSelected = selectedIds.has(sale.id);
              return (
                <li key={sale.id}>
                  <button
                    type="button"
                    onClick={() => toggleSelect(sale.id)}
                    aria-pressed={isSelected}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40",
                      isSelected && "bg-info/15",
                    )}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {isSelected ? (
                        <CheckCircle2
                          className="h-5 w-5 shrink-0 text-info"
                          aria-hidden="true"
                        />
                      ) : (
                        <Circle
                          className="h-5 w-5 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                      )}
                      <div className="min-w-0">
                        <div className="font-medium text-foreground truncate">
                          {sale.no}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {sale.customer_name ?? "Walk-in"} ·{" "}
                          {sale.items.length} item
                          {sale.items.length === 1 ? "" : "s"} ·{" "}
                          {sale.date}
                        </div>
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="font-medium tabular-nums text-foreground">
                        {formatRupeesFromPaise(sale.total)}
                      </div>
                      {sale.paid_amount < sale.total && (
                        <Badge variant="warning" size="sm">
                          Partial
                        </Badge>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="border-t border-border px-4 py-3">
            <PaginationControls
              page={page}
              totalPages={totalPages}
              totalItems={filtered.length}
              pageSize={pageSize}
              onPageChange={setPage}
            />
          </div>
        </Card>
      )}

      {searching && filtered.length === 0 && (
        <p className="text-center text-sm text-muted-foreground py-4">
          Loading…
        </p>
      )}
    </div>
  );
}

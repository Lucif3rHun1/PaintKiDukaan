import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, X } from "lucide-react";
import { listSales } from "../../pos/api";
import { cn } from "../../components/ui/cn";
import { Badge } from "../../components/ui";
import { SearchInput } from "../../components/ui";
import { formatRupeesFromPaise } from "../../lib/money";
import type { Sale } from "../types";

interface Props {
  /** Already-linked invoices shown as chips above the search. */
  linked: Sale[];
  /** Called when a single sale row is clicked. Parent owns the merge. */
  onLink: (next: Sale[]) => void;
  /** Called when a single chip is removed. */
  onUnlink: (saleId: number) => void;
  /** Maximum number of results to display in the dropdown. Default 8. */
  maxResults?: number;
}

const SEARCH_DEBOUNCE_MS = 200;

export function InvoiceSearchInput({
  linked,
  onLink,
  onUnlink,
  maxResults = 8,
}: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Sale[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  // linkedIds is the ONLY filter source — toggling does not retrigger fetch.
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
          rows
            .filter((r) => r.status === "final" && !linkedIds.has(r.id))
            .slice(0, maxResults),
        );
      } catch (e) {
        if (seqRef.current !== seq) return;
        setError(e instanceof Error ? e.message : String(e));
        setResults([]);
      } finally {
        if (seqRef.current === seq) setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [linkedIds, maxResults]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return results;
    return results.filter(
      (r) =>
        r.no.toLowerCase().includes(q) ||
        (r.customer_name ?? "").toLowerCase().includes(q),
    );
  }, [results, query]);

  function handlePick(sale: Sale) {
    if (linkedIds.has(sale.id)) return;
    onLink([...linked, sale]);
    // Clear the row from results so the user gets a visible signal.
    setResults((prev) => prev.filter((r) => r.id !== sale.id));
  }

  return (
    <div className="space-y-2">
      {linked.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {linked.map((s) => (
            <Badge key={s.id} variant="info" size="sm" className="gap-1 pr-1">
              <FileText className="h-3 w-3" aria-hidden="true" />
              {s.no}
              <button
                type="button"
                onClick={() => onUnlink(s.id)}
                aria-label={`Unlink ${s.no}`}
                className="ml-1 rounded-full p-0.5 hover:bg-info/40"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      <SearchInput
        value={query}
        onChange={setQuery}
        debounceMs={150}
        placeholder="Search invoice no. or customer…"
        ariaLabel="Search invoices"
      />

      {error && <p className="text-xs text-destructive">{error}</p>}

      <ul className="divide-y divide-border rounded-md ring-1 ring-border/40">
        {filtered.length === 0 ? (
          <li className="px-3 py-3 text-center text-xs text-muted-foreground">
            {searching ? "Loading…" : query.trim() ? "No matches." : "Start typing to search invoices."}
          </li>
        ) : (
          filtered.map((sale) => (
            <li key={sale.id}>
              <button
                type="button"
                onClick={() => handlePick(sale)}
                aria-label={`Link invoice ${sale.no}`}
                className={cn(
                  "flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/40",
                )}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div className="min-w-0">
                    <div className="font-mono tabular-nums text-foreground truncate">{sale.no}</div>
                    <div className="text-[11px] text-muted-foreground truncate">
                      {sale.customer_name ?? "Walk-in"} · {sale.items.length} item
                      {sale.items.length === 1 ? "" : "s"} · {sale.date}
                    </div>
                  </div>
                </div>
                <div className="shrink-0 font-medium tabular-nums text-foreground">
                  {formatRupeesFromPaise(sale.total)}
                </div>
              </button>
            </li>
          ))
        )}
      </ul>

      {linked.length === 0 && (
        <p className="text-[11px] text-muted-foreground">
          Link 1+ invoices to scope items, or leave empty to refund any item.
        </p>
      )}
    </div>
  );
}

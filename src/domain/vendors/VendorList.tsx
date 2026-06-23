/**
 * VendorList — searchable list with outstanding + role-gated Pay action.
 * Debounced search, batch outstanding fetch (no N+1), design-system tokens.
 */
import { useEffect, useRef, useState } from "react";
import { Banknote, Phone, Search, Truck } from "lucide-react";

import { Alert, Button, Card, EmptyState, Money, Skeleton } from "../../components/ui";
import { toast } from "../../lib/feedback/toast";
import { listVendors } from "./api";
import { outstandingReport } from "../../pos/api";
import { type Vendor } from "../types";
import { extractError } from "../../lib/extractError";

interface Props {
  onSelect?: (v: Vendor) => void;
  onCreate?: () => void;
  onRecordPayment?: (v: Vendor) => void;
  refreshKey?: number;
  role: "owner" | "cashier" | "stocker";
}

const SEARCH_DEBOUNCE_MS = 250;

export function VendorList({
  onSelect,
  onCreate,
  onRecordPayment,
  refreshKey,
  role,
}: Props) {
  const [items, setItems] = useState<Vendor[]>([]);
  const [outstandings, setOutstandings] = useState<Record<number, number>>({});
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce query input
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  // Fetch vendors + batch outstanding on debounced query or refreshKey
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listVendors(debouncedQuery || undefined)
      .then(async (rows) => {
        if (cancelled) return;
        setItems(rows);
        // Batch fetch: one outstandingReport call returns all vendors
        // at once. No N+1, no per-vendor round-trip.
        try {
          const report = await outstandingReport();
          if (cancelled) return;
          const map: Record<number, number> = {};
          for (const v of report.vendors) {
            map[v.vendor_id] = v.outstanding;
          }
          setOutstandings(map);
        } catch (e) {
          // If the batch outstanding call fails, surface but don't fail
          // the whole list — outstanding is optional info.
          if (!cancelled) {
            toast.warning(extractError(e));
            setOutstandings({});
          }
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(extractError(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, refreshKey]);

  function handlePay(v: Vendor) {
    if (onRecordPayment) {
      onRecordPayment(v);
      return;
    }
    toast.info(`No payment handler available for ${v.name}`);
  }

  const canCreate = onCreate && (role === "owner" || role === "stocker");
  const canPay = (role === "owner" || role === "stocker") && onRecordPayment;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-2xl font-semibold tracking-tight">Vendors</h2>
          <p className="text-sm text-muted-foreground">
            {items.length} {items.length === 1 ? "vendor" : "vendors"}
            {debouncedQuery ? ` matching "${debouncedQuery}"` : ""}
          </p>
        </div>
        {canCreate ? (
          <Button
            type="button"
            variant="primary"
            size="md"
            icon={Truck}
            onClick={onCreate}
          >
            New vendor
          </Button>
        ) : null}
      </header>

      <Card>
        <Card.Body className="space-y-3">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              type="search"
              placeholder="Search by name or phone…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="input h-10 w-full pl-9"
              aria-label="Search vendors"
            />
          </div>

          {error ? (
            <Alert title="Could not load vendors" variant="destructive">
              {error}
            </Alert>
          ) : null}

          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={Truck}
              title={debouncedQuery ? "No matches" : "No vendors yet"}
              description={
                debouncedQuery
                  ? `Nothing matches "${debouncedQuery}". Try a different search.`
                  : "Add the first vendor to start receiving stock and tracking payables."
              }
              primary={
                canCreate ? (
                  <Button type="button" onClick={onCreate} icon={Truck}>
                    Add vendor
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Phone</th>
                    <th className="px-3 py-2 text-right font-medium">Opening</th>
                    <th className="px-3 py-2 text-right font-medium">Outstanding</th>
                    {canPay ? (
                      <th className="px-3 py-2 text-right font-medium">Action</th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {items.map((v) => (
                    <tr
                      key={v.id}
                      onClick={() => onSelect?.(v)}
                      className={[
                        "cursor-pointer border-b border-border last:border-b-0",
                        "transition-colors hover:bg-muted/50",
                        v.is_active ? "" : "opacity-60",
                      ].join(" ")}
                    >
                      <td className="px-3 py-2.5 font-medium text-foreground">
                        {v.name}
                      </td>
                      <td className="px-3 py-2.5">
                        {v.phone ? (
                          <span className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
                            <Phone className="h-3 w-3" />
                            {v.phone}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <Money paise={v.opening_balance} muted />
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {outstandings[v.id] != null ? (
                          <Money
                            paise={outstandings[v.id]}
                            negative={outstandings[v.id] < 0}
                          />
                        ) : (
                          <span className="text-xs text-muted-foreground">…</span>
                        )}
                      </td>
                      {canPay ? (
                        <td
                          className="px-3 py-2.5 text-right"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            icon={Banknote}
                            onClick={() => handlePay(v)}
                          >
                            Pay
                          </Button>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card.Body>
      </Card>
    </div>
  );
}

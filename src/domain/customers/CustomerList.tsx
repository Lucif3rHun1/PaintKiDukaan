/**
 * CustomerList — searchable list with flag indicator + role-gated actions.
 * Debounced search, design-system tokens, empty/loading states.
 */
import { useEffect, useRef, useState } from "react";
import { Search, UserPlus, Flag, Phone, Banknote, IndianRupee } from "lucide-react";

import { Alert, Badge, Button, Card, EmptyState, Money, Skeleton } from "../../components/ui";
import { toast } from "../../lib/feedback/toast";
import { listCustomers } from "./api";
import { formatRupeesFromPaise } from "../../lib/money";
import type { Customer } from "../types";
import { extractError } from "../../lib/extractError";

interface Props {
  onSelect?: (c: Customer) => void;
  onCreate?: () => void;
  onRecordPayment?: (c: Customer) => void;
  refreshKey?: number;
  role: "owner" | "cashier" | "stocker";
}

const SEARCH_DEBOUNCE_MS = 250;

export function CustomerList({
  onSelect,
  onCreate,
  onRecordPayment,
  refreshKey,
  role,
}: Props) {
  const [items, setItems] = useState<Customer[]>([]);
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

  // Fetch on debounced query or refreshKey
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listCustomers(debouncedQuery || undefined)
      .then((rows) => {
        if (!cancelled) setItems(rows);
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

  function handlePay(c: Customer) {
    if (onRecordPayment) {
      onRecordPayment(c);
      return;
    }
    toast.info(`No payment handler available for ${c.name}`);
  }

  const canCreate = onCreate && (role === "owner" || role === "cashier");
  const canPay = (role === "owner" || role === "cashier") && onRecordPayment;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-2xl font-semibold tracking-tight">Customers</h2>
          <p className="text-sm text-muted-foreground">
            {items.length} {items.length === 1 ? "customer" : "customers"}
            {debouncedQuery ? ` matching "${debouncedQuery}"` : ""}
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
              aria-label="Search customers"
            />
          </div>

          {error ? (
            <Alert
              title="Could not load customers"
              variant="destructive"
            >
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
              icon={UserPlus}
              title={debouncedQuery ? "No matches" : "No customers yet"}
              description={
                debouncedQuery
                  ? `Nothing matches "${debouncedQuery}". Try a different search.`
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
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Phone</th>
                    <th className="px-3 py-2 font-medium">Type</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 text-right font-medium">Credit</th>
                    <th className="px-3 py-2 text-right font-medium">Opening</th>
                    {canPay ? (
                      <th className="px-3 py-2 text-right font-medium">Action</th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {items.map((c, i) => (
                    <tr
                      key={c.id}
                      onClick={() => onSelect?.(c)}
                      className={[
                        "cursor-pointer border-b border-border last:border-b-0",
                        "transition-colors hover:bg-muted/50",
                        "animate-in fade-in slide-in-from-bottom-2 duration-200",
                        c.is_active ? "" : "opacity-60",
                      ].join(" ")}
                      style={{ animationDelay: `${i * 40}ms` }}
                    >
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-foreground">
                            {c.name}
                          </span>
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
                      </td>
                      <td className="px-3 py-2.5">
                        {c.phone ? (
                          <span className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
                            <Phone className="h-3 w-3" />
                            {c.phone}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">
                        {c.type_name ?? "—"}
                      </td>
                      <td className="px-3 py-2.5">
                        {!c.is_active ? (
                          <Badge variant="muted" size="sm">
                            Inactive
                          </Badge>
                        ) : (
                          <Badge variant="success" size="sm">
                            Active
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {c.credit_limit != null ? (
                          <span className="inline-flex items-baseline gap-1">
                            <IndianRupee className="h-3 w-3 translate-y-[0.1em] text-muted-foreground" />
                            {formatRupeesFromPaise(c.credit_limit)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <Money paise={c.opening_balance_paise} muted />
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
                            onClick={() => handlePay(c)}
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

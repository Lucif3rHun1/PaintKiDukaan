
import { useEffect, useMemo, useRef, useState } from "react";
import { Search, UserPlus, Users } from "lucide-react";
import { Button, Badge } from "../../components/ui";
import { toTitleCase } from "../../lib/format/titleCase";
import { formatRupeesFromPaise } from "../../lib/money";
import { listCustomers } from "../../domain/customers/api";
import type { Customer } from "../../domain/types";

/** Per-page configuration for what customer info to show in the dropdown. */
export interface CustomerDisplayConfig {
  /** Show opening balance in search results (default: false). */
  showBalance?: boolean;
  /** Show customer type badge (default: false). */
  showType?: boolean;
  /** Allow selecting walk-in customer (default: true). Set false when a real customer is required. */
  allowWalkIn?: boolean;
}

interface Props {
  selectedId: number | null;
  selectedCustomer?: Customer | null;
  recentCustomers?: Customer[];
  onChange: (id: number | null, customer: Customer | null) => void;
  onWalkIn?: () => void;
  onCreate: () => void;
  display?: CustomerDisplayConfig;
}

export function CustomerAutocomplete({ selectedId, selectedCustomer, recentCustomers = [], onChange, onWalkIn, onCreate, display }: Props) {
  const { showBalance = false, showType = false, allowWalkIn = true } = display ?? {};
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Customer[]>([]);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [walkIn, setWalkIn] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const recents = useMemo(() => {
    const seen = new Set<number>();
    return recentCustomers.filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    }).slice(0, 5);
  }, [recentCustomers]);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const id = ++requestIdRef.current;
    const timer = setTimeout(() => {
      listCustomers(query.trim().toLowerCase(), false)
        .then((d) => {
          if (id === requestIdRef.current) setResults(d ?? []);
        })
        .catch((e) => {
          console.error("[CustomerAutocomplete] failed to load customers", e);
          if (id === requestIdRef.current) setResults([]);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current);
    };
  }, []);

  const selected = selectedCustomer ?? (selectedId != null ? results.find((c) => c.id === selectedId) ?? null : null);
  const showSuggestions = focused && !query.trim();
  const hasResults = results.length > 0;
  const hasRecents = recents.length > 0;

  function handleSelectWalkIn() {
    setWalkIn(true);
    onChange(null, null);
    onWalkIn?.();
    setQuery("");
    setOpen(false);
  }

  function handleSelectCustomer(c: Customer) {
    setWalkIn(false);
    onChange(c.id, c);
    setQuery("");
    setOpen(false);
  }

  function handleCreate() {
    setOpen(false);
    onCreate();
  }

  return (
    <div ref={ref} className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <input
          type="text"
          role="combobox"
          aria-expanded={open && (showSuggestions || hasResults)}
          aria-autocomplete="list"
          aria-label="Search customer"
          placeholder="Search customer by name or phone…"
          value={walkIn ? "Walk-in" : selected ? `${toTitleCase(selected.name)} (${selected.phone})` : query}
          onChange={(e) => {
            setWalkIn(false);
            setQuery(e.target.value);
            if (selectedId) onChange(null, null);
            setOpen(true);
          }}
          onFocus={() => {
            setWalkIn(false);
            setFocused(true);
            setOpen(true);
          }}
          onBlur={() => {
            // Defer blur so click events on dropdown items fire first
            blurTimeoutRef.current = setTimeout(() => setFocused(false), 150);
          }}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          className="input h-10 w-full pl-9 pr-3"
        />
      </div>
      {open && (showSuggestions || hasResults || query.trim()) && (
        <div className="surface-overlay absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-border shadow-overlay">
          {showSuggestions && allowWalkIn && (
            <>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleSelectWalkIn}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
              >
                <Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <span className="font-medium text-foreground">Walk-in</span>
              </button>
              {hasRecents && (
                <>
                  <div className="px-3 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Recent</div>
                  {recents.map((c) => (
                    <CustomerOption key={c.id} customer={c} onSelect={() => handleSelectCustomer(c)} showBalance={showBalance} showType={showType} />
                  ))}
                </>
              )}
            </>
          )}
          {showSuggestions && !allowWalkIn && hasRecents && (
            <>
              <div className="px-3 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Recent</div>
              {recents.map((c) => (
                <CustomerOption key={c.id} customer={c} onSelect={() => handleSelectCustomer(c)} showBalance={showBalance} showType={showType} />
              ))}
            </>
          )}
          {query.trim() && hasResults && (
            <>
              {results.map((c) => (
                <CustomerOption key={c.id} customer={c} onSelect={() => handleSelectCustomer(c)} showBalance={showBalance} showType={showType} />
              ))}
            </>
          )}
          {query.trim() && !hasResults && (
            <div className="px-3 py-4 text-center text-sm text-muted-foreground">
              No customers found
            </div>
          )}
          <div className="border-t border-border p-2">
            <Button type="button" variant="secondary" size="sm" icon={UserPlus} onClick={handleCreate} className="w-full">
              New customer
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function CustomerOption({ customer, onSelect, showBalance, showType }: { customer: Customer; onSelect: () => void; showBalance: boolean; showType: boolean }) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onSelect}
      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
    >
      <span className="min-w-0 flex-1">
        <span className="font-medium text-foreground">{toTitleCase(customer.name)}</span>
        <span className="ml-2 text-xs text-muted-foreground">{customer.phone}</span>
        {showType && customer.type_name && (
          <span className="ml-2 text-xs text-muted-foreground">({customer.type_name})</span>
        )}
        {showBalance && customer.opening_balance_paise !== 0 && (
          <span className={`ml-2 text-xs font-medium ${customer.opening_balance_paise > 0 ? "text-destructive" : "text-success"}`}>
            {formatRupeesFromPaise(Math.abs(customer.opening_balance_paise))} {customer.opening_balance_paise > 0 ? "due" : "credit"}
          </span>
        )}
      </span>
      <span className="flex shrink-0 gap-1">
        {!customer.is_active && <Badge variant="danger" size="sm">Inactive</Badge>}
        {customer.is_flagged && <Badge variant="warning" size="sm">Flagged</Badge>}
      </span>
    </button>
  );
}

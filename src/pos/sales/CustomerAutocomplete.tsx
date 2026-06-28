
import { useEffect, useMemo, useRef, useState } from "react";
import { Search, UserPlus, Users } from "lucide-react";
import { Button, Badge } from "../../components/ui";
import { toTitleCase } from "../../lib/format/titleCase";
import { listCustomers } from "../../domain/customers/api";
import type { Customer } from "../../domain/types";

interface Props {
  selectedId: number | null;
  selectedCustomer?: Customer | null;
  recentCustomers?: Customer[];
  onChange: (id: number | null, customer: Customer | null) => void;
  onCreate: () => void;
}

export function CustomerAutocomplete({ selectedId, selectedCustomer, recentCustomers = [], onChange, onCreate }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Customer[]>([]);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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
    const timer = setTimeout(() => {
      listCustomers(query, false)
        .then((d) => setResults(d ?? []))
        .catch((e) => {
          console.error("[CustomerAutocomplete] failed to load customers", e);
          setResults([]);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const selected = selectedCustomer ?? (selectedId != null ? results.find((c) => c.id === selectedId) ?? null : null);
  const showSuggestions = focused && !query.trim();
  const hasResults = results.length > 0;
  const hasRecents = recents.length > 0;

  function handleSelectWalkIn() {
    onChange(null, null);
    setQuery("");
    setOpen(false);
  }

  function handleSelectCustomer(c: Customer) {
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
          placeholder="Search customer by name or phone…"
          value={selected ? `${toTitleCase(selected.name)} (${selected.phone})` : query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (selectedId) onChange(null, null);
            setOpen(true);
          }}
          onFocus={() => {
            setFocused(true);
            setOpen(true);
          }}
          onBlur={() => setFocused(false)}
          className="input h-10 w-full pl-9 pr-3"
        />
      </div>
      {open && (showSuggestions || hasResults) && (
        <div className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-border bg-card shadow-lg">
          {showSuggestions && (
            <>
              <button
                type="button"
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
                    <CustomerOption key={c.id} customer={c} onSelect={() => handleSelectCustomer(c)} />
                  ))}
                </>
              )}
            </>
          )}
          {query.trim() && hasResults && (
            <>
              {results.map((c) => (
                <CustomerOption key={c.id} customer={c} onSelect={() => handleSelectCustomer(c)} />
              ))}
            </>
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

function CustomerOption({ customer, onSelect }: { customer: Customer; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
    >
      <span>
        <span className="font-medium text-foreground">{toTitleCase(customer.name)}</span>
        <span className="ml-2 text-xs text-muted-foreground">{customer.phone}</span>
      </span>
      {!customer.is_active && <Badge variant="danger" size="sm">Inactive</Badge>}
      {customer.is_flagged && <Badge variant="warning" size="sm">Flagged</Badge>}
    </button>
  );
}


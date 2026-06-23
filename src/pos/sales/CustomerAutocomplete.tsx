import { useEffect, useRef, useState } from "react";
import { Search, UserPlus } from "lucide-react";
import { Button, Badge } from "../../components/ui";
import { listCustomers } from "../../domain/customers/api";
import type { Customer } from "../../domain/types";

interface Props {
  selectedId: number | null;
  selectedCustomer?: Customer | null;
  onChange: (id: number | null, customer: Customer | null) => void;
  onCreate: () => void;
}

export function CustomerAutocomplete({ selectedId, selectedCustomer, onChange, onCreate }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Customer[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      listCustomers(query, false).then(setResults).catch(() => setResults([]));
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

  return (
    <div ref={ref} className="relative">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            type="text"
            placeholder="Search customer by name or phone…"
            value={selected ? `${selected.name} (${selected.phone})` : query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (selectedId) onChange(null, null);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            className="input h-10 w-full pl-9 pr-3"
          />
        </div>
        <Button type="button" variant="secondary" size="sm" icon={UserPlus} onClick={onCreate}>
          New
        </Button>
      </div>
      {open && results.length > 0 && (
        <div className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-border bg-card shadow-lg">
          {results.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                onChange(c.id, c);
                setQuery("");
                setOpen(false);
              }}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
            >
              <span>
                <span className="font-medium text-foreground">{c.name}</span>
                <span className="ml-2 text-xs text-muted-foreground">{c.phone}</span>
              </span>
              {!c.is_active && <Badge variant="danger" size="sm">Inactive</Badge>}
              {c.is_flagged && <Badge variant="warning" size="sm">Flagged</Badge>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

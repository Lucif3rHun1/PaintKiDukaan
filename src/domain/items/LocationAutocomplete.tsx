/**
 * LocationAutocomplete — datalist-backed free text input. Pulls active
 * locations from the DB so pick-lists stay in sync with the inventory team.
 */
import { useEffect, useState } from "react";
import { listLocations } from "../locations/api";
import type { Location } from "../types";

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  className?: string;
}

export function LocationAutocomplete({
  value,
  onChange,
  placeholder = "e.g. Rack A / Bay 3",
  required,
  className,
}: Props) {
  const [locations, setLocations] = useState<Location[]>([]);
  const listId = "location-autocomplete-list";

  useEffect(() => {
    listLocations(false)
      .then(setLocations)
      .catch(() => setLocations([]));
  }, []);

  return (
    <div className={className}>
      <input
        type="text"
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        className="w-full rounded border border-slate-300 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none"
      />
      <datalist id={listId}>
        {locations.map((loc) => (
          <option key={loc.id} value={loc.name}>
            {loc.rack ? `${loc.name} (${loc.rack})` : loc.name}
          </option>
        ))}
      </datalist>
      <p className="mt-1 text-xs text-slate-500">
        Pick a known location or type a new label.
      </p>
    </div>
  );
}

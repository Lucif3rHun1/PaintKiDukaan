import { Select } from "./Select";
import { DatePicker } from "./DatePicker";
import { todayLocalYyyymmdd, shiftDaysLocal } from "../../lib/date";
import { cn } from "./cn";

export interface PeriodRange {
  from: string;
  to: string;
}

const ALL_START = "";
const ALL_END = "";

const PRESETS: { label: string; from: string; to: string }[] = [
  { label: "Today", get from() { return todayLocalYyyymmdd(); }, get to() { return todayLocalYyyymmdd(); } },
  { label: "Last 7 Days", get from() { return shiftDaysLocal(6); }, get to() { return todayLocalYyyymmdd(); } },
  { label: "This Month", get from() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  }, get to() { return todayLocalYyyymmdd(); } },
  { label: "Last Month", get from() {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  }, get to() {
    const d = new Date();
    d.setDate(0);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  } },
  { label: "All Time", from: ALL_START, to: ALL_END },
];

const CUSTOM_KEY = "__custom__";

function matchPreset(value: PeriodRange): string {
  for (const p of PRESETS) {
    if (value.from === p.from && value.to === p.to) return p.label;
  }
  if (!value.from && !value.to) return "All Time";
  return CUSTOM_KEY;
}

interface PeriodDropdownProps {
  value: PeriodRange;
  onChange: (from: string, to: string) => void;
  className?: string;
  /** Allow custom date range selection via inline DatePickers */
  allowCustom?: boolean;
}

export function PeriodDropdown({ value, onChange, className, allowCustom = false }: PeriodDropdownProps) {
  const currentLabel = matchPreset(value);
  const isCustom = currentLabel === CUSTOM_KEY;

  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <Select
        options={[]}
        size="sm"
        className="w-auto min-w-[140px]"
        value={isCustom ? CUSTOM_KEY : currentLabel}
        aria-label="Select period"
        onChange={(e) => {
          if (e.target.value === CUSTOM_KEY) return;
          const preset = PRESETS.find((p) => p.label === e.target.value);
          if (preset) onChange(preset.from, preset.to);
        }}
      >
        {PRESETS.map((p) => (
          <option key={p.label} value={p.label}>
            {p.label}
          </option>
        ))}
        {allowCustom && <option value={CUSTOM_KEY}>Custom…</option>}
      </Select>

      {allowCustom && isCustom && (
        <div className="flex items-center gap-1">
          <DatePicker value={value.from} onChange={(f) => onChange(f, value.to)} />
          <span className="text-xs text-muted-foreground">to</span>
          <DatePicker value={value.to} onChange={(t) => onChange(value.from, t)} />
        </div>
      )}
    </div>
  );
}

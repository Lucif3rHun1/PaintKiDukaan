import { useState, useRef, useEffect, useCallback } from "react";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "./cn";

export interface DatePickerProps {
  value?: string; // ISO date string YYYY-MM-DD
  onChange?: (date: string) => void;
  placeholder?: string;
  className?: string;
}

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number) {
  return new Date(year, month, 1).getDay();
}

function formatDate(year: number, month: number, day: number): string {
  const m = String(month + 1).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${year}-${m}-${d}`;
}

function parseValue(value?: string) {
  if (!value) {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth(), day: now.getDate() };
  }
  const [y, m, d] = value.split("-").map(Number);
  return { year: y, month: m - 1, day: d };
}

export function DatePicker({ value, onChange, placeholder = "Pick date", className }: DatePickerProps) {
  const { year, month, day: selectedDay } = parseValue(value);
  const [open, setOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [viewMonth, setViewMonth] = useState(month);
  const [viewYear, setViewYear] = useState(year);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const enterFrameRef = useRef<number | null>(null);

  const closePicker = useCallback(() => {
    if (!open) return;
    if (enterFrameRef.current !== null) {
      window.cancelAnimationFrame(enterFrameRef.current);
      enterFrameRef.current = null;
    }
    setOpen(false);
    setIsVisible(false);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setIsClosing(false);
      return;
    }
    setIsClosing(true);
  }, [open]);

  function openPicker() {
    if (enterFrameRef.current !== null) {
      window.cancelAnimationFrame(enterFrameRef.current);
    }
    setOpen(true);
    setIsClosing(false);
    setIsVisible(false);
    enterFrameRef.current = window.requestAnimationFrame(() => {
      setIsVisible(true);
      enterFrameRef.current = null;
    });
  }

  useEffect(
    () => () => {
      if (enterFrameRef.current !== null) {
        window.cancelAnimationFrame(enterFrameRef.current);
      }
    },
    [],
  );

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) closePicker();
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open, closePicker]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      closePicker();
      triggerRef.current?.focus();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, closePicker]);

  // Sync view when value changes
  useEffect(() => {
    setViewMonth(month);
    setViewYear(year);
  }, [month, year]);

  const select = useCallback((y: number, m: number, d: number) => {
    onChange?.(formatDate(y, m, d));
    closePicker();
  }, [onChange, closePicker]);

  const daysInMonth = getDaysInMonth(viewYear, viewMonth);
  const firstDay = getFirstDayOfMonth(viewYear, viewMonth);
  const today = new Date();
  const isCurrentMonth = viewYear === today.getFullYear() && viewMonth === today.getMonth();

  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const displayText = value
    ? `${MONTHS[month]} ${selectedDay}, ${year}`
    : placeholder;

  return (
    <div ref={ref} className={cn("relative", className)}>
      {/* Trigger */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (open) closePicker();
          else openPicker();
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="date-picker-dialog"
        className={cn(
          "input flex w-full items-center gap-2 px-2 py-1 text-left text-sm",
          !value && "text-muted-foreground",
        )}
      >
        <Calendar className="h-4 w-4 shrink-0 opacity-50" />
        <span className="truncate">{displayText}</span>
      </button>

      {/* Popover */}
      {(open || isClosing) && (
        <div
          id="date-picker-dialog"
          role="dialog"
          aria-label="Choose date"
          onTransitionEnd={(event) => {
            if (
              isClosing &&
              event.target === event.currentTarget &&
              event.propertyName === "opacity"
            ) {
              setIsClosing(false);
            }
          }}
          className={cn(
            "absolute z-50 mt-1 origin-top-left rounded-lg border border-border bg-popover p-3 shadow-lg transition-[opacity,transform] duration-fast ease-out motion-reduce:transition-none motion-reduce:scale-100 motion-reduce:opacity-100",
            isVisible ? "scale-100 opacity-100" : "scale-[0.97] opacity-0",
          )}
        >
          {/* Month/Year nav */}
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => {
                if (viewMonth === 0) { setViewMonth(11); setViewYear(viewYear - 1); }
                else setViewMonth(viewMonth - 1);
              }}
              aria-label="Previous month"
              className="inline-flex h-10 w-10 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-medium text-foreground">
              {MONTHS[viewMonth]} {viewYear}
            </span>
            <button
              type="button"
              onClick={() => {
                if (viewMonth === 11) { setViewMonth(0); setViewYear(viewYear + 1); }
                else setViewMonth(viewMonth + 1);
              }}
              aria-label="Next month"
              className="inline-flex h-10 w-10 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {/* Day headers */}
          <div className="mb-1 grid grid-cols-7 gap-0.5">
            {DAYS.map((d) => (
              <div key={d} className="py-1 text-center text-xs font-medium text-muted-foreground">
                {d}
              </div>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7 gap-0.5">
            {cells.map((d, i) => {
              if (d === null) return <div key={`e${i}`} />;
              const isSelected = viewYear === year && viewMonth === month && d === selectedDay;
              const isToday = isCurrentMonth && d === today.getDate();
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => select(viewYear, viewMonth, d)}
                  aria-current={isSelected ? "date" : undefined}
                  className={cn(
                    "h-10 w-10 rounded text-sm transition-colors",
                    isSelected
                      ? "bg-primary text-primary-foreground font-medium"
                      : isToday
                        ? "bg-accent text-accent-foreground font-medium"
                        : "text-foreground hover:bg-accent",
                  )}
                >
                  {d}
                </button>
              );
            })}
          </div>

          {/* Today button */}
          <button
            type="button"
            onClick={() => {
              const t = new Date();
              select(t.getFullYear(), t.getMonth(), t.getDate());
            }}
            className="mt-2 min-h-10 w-full rounded border border-border px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Today
          </button>
        </div>
      )}
    </div>
  );
}

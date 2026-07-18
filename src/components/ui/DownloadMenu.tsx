import { useCallback, useEffect, useId, useRef, useState } from "react";
import { FileDown } from "lucide-react";
import { Button } from "./Button";
import { cn } from "./cn";

export interface DownloadMenuProps {
  headers: string[];
  rows: (string | number)[][];
  filename: string;
  title?: string;
  subtitle?: string;
  className?: string;
  label?: string;
  loadRows?: () => Promise<(string | number)[][]>;
  onError?: (error: unknown) => void;
}

export function DownloadMenu({
  headers,
  rows,
  filename,
  title = filename,
  subtitle,
  className,
  label = "Download",
  loadRows,
  onError,
}: DownloadMenuProps) {
  const [open, setOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const enterFrameRef = useRef<number | null>(null);
  const menuId = useId();

  const closeMenu = useCallback(() => {
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

  function openMenu() {
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

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (event.target instanceof Node && ref.current?.contains(event.target)) return;
      closeMenu();
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open, closeMenu]);

  const download = async (format: "csv" | "xlsx" | "pdf") => {
    setLoading(true);
    try {
      const currentRows = loadRows ? await loadRows() : rows;
      if (format === "pdf") {
        const { buildPdf } = await import("../../lib/pdf");
        buildPdf(headers, currentRows, title, subtitle);
      } else {
        const { downloadSpreadsheet } = await import("../../lib/spreadsheet");
        const sheetRows = currentRows.map((row) => row.map((cell) => String(cell ?? "")));
        downloadSpreadsheet(headers, sheetRows, filename, format);
      }
      closeMenu();
    } catch (error) {
      onError?.(error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      ref={ref}
      className={cn("relative inline-flex", className)}
      onKeyDown={(event) => {
        if (event.key === "Escape") closeMenu();
      }}
    >
      <Button
        type="button"
        size="sm"
        variant="secondary"
        icon={FileDown}
        loading={loading}
        className="min-h-10"
        onClick={() => {
          if (open) closeMenu();
          else openMenu();
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
      >
        {loading ? "Preparing…" : label}
      </Button>
      {open || isClosing ? (
        <div
          id={menuId}
          role="menu"
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
            "absolute right-0 top-full z-50 mt-1 w-32 origin-top-right rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-xl transition-[opacity,transform] duration-fast ease-out will-change-transform motion-reduce:transition-none motion-reduce:opacity-100 motion-reduce:scale-100",
            isVisible ? "scale-100 opacity-100" : "scale-[0.97] opacity-0",
          )}
        >
          {(["CSV", "XLSX", "PDF"] as const).map((label) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              disabled={loading}
              className="flex min-h-10 w-full items-center rounded-md px-3 py-2 text-left hover:bg-muted focus:bg-muted focus:outline-none"
              onClick={() => void download(label.toLowerCase() as "csv" | "xlsx" | "pdf")}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

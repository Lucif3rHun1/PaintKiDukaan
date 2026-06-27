import { useEffect, useRef, useState } from "react";
import { FileDown } from "lucide-react";
import { buildPdf } from "../../lib/pdf";
import { downloadSpreadsheet } from "../../lib/spreadsheet";
import { cn } from "./cn";

export interface DownloadMenuProps {
  headers: string[];
  rows: (string | number)[][];
  filename: string;
  title?: string;
  subtitle?: string;
  className?: string;
}

export function DownloadMenu({
  headers,
  rows,
  filename,
  title = filename,
  subtitle,
  className,
}: DownloadMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const sheetRows = rows.map((row) => row.map((cell) => String(cell ?? "")));
  const download = (format: "csv" | "xlsx" | "pdf") => {
    if (format === "pdf") {
      buildPdf(headers, rows, title, subtitle);
    } else {
      downloadSpreadsheet(headers, sheetRows, filename, format);
    }
    setOpen(false);
  };

  return (
    <div ref={ref} className={cn("relative inline-flex", className)}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <FileDown className="h-3.5 w-3.5" aria-hidden="true" />
        Download
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 w-32 rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-xl"
        >
          {(["CSV", "XLSX", "PDF"] as const).map((label) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              className="flex w-full rounded-md px-3 py-1.5 text-left hover:bg-muted focus:bg-muted focus:outline-none"
              onClick={() => download(label.toLowerCase() as "csv" | "xlsx" | "pdf")}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

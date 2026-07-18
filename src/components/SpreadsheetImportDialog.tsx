import { useCallback, useMemo, useRef, useState } from "react";
import {
  FileUp,
  Loader2,
  CheckCircle,
  AlertTriangle,
  AlertCircle,
  Download,
  Pencil,
  Lock,
  X,
} from "lucide-react";

import { Button, Alert } from "./ui";
import { cn } from "./ui/cn";
import type { ImportResult } from "../domain/types";
import {
  parseSpreadsheet,
  toCsvText,
  downloadTemplate,
  validateCell,
  type ColumnType,
  type TemplateColumn,
} from "../lib/spreadsheet";
import { extractError } from "../lib/extractError";

/* ── public types ────────────────────────────────────────────── */

export interface ImportColumn {
  /** Canonical column name (lowercase, underscore). */
  name: string;
  /** If true, empty cells in this column are flagged. */
  required: boolean;
  /** Type used for per-cell validation; defaults to "string". */
  type?: ColumnType;
  /** Example value shown in the template row. */
  example?: string;
  /** If true, cell is displayed as read-only (auto-generated/prefixed values). */
  readonly?: boolean;
}

export interface SpreadsheetImportDialogProps {
  open: boolean;
  onClose: () => void;
  onImported: () => void;

  /** Dialog heading, e.g. "Import Items from Spreadsheet". */
  title: string;
  /** Subtitle shown under the heading. */
  description: string;

  /** Column definitions for this import type. */
  columns: ImportColumn[];

  /** Basename for template downloads (no extension). */
  templateFilename: string;

  /** The Tauri import API that accepts raw CSV text. */
  importApi: (csvText: string) => Promise<ImportResult>;
}

/* ── component ───────────────────────────────────────────────── */

type Phase = "select" | "preview" | "importing" | "done";

function parseHeaderDisplay(header: string): string {
  const orIdx = header.indexOf("(or ");
  if (orIdx > 0) return header.slice(0, orIdx).trim();
  return header;
}

export function SpreadsheetImportDialog({
  open,
  onClose,
  onImported,
  title,
  description,
  columns,
  templateFilename,
  importApi,
}: SpreadsheetImportDialogProps) {
  const fileRef = useRef<HTMLInputElement>(null);

  const [phase, setPhase] = useState<Phase>("select");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [skipped, setSkipped] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<{ row: number; col: number } | null>(
    null,
  );
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);

  // Required column names for quick lookup
  const requiredCols = columns.filter((c) => c.required).map((c) => c.name);

  const reset = useCallback(() => {
    setPhase("select");
    setHeaders([]);
    setRows([]);
    setSkipped(new Set());
    setEditing(null);
    setResult(null);
    setError(null);
    setTemplateOpen(false);
    if (fileRef.current) fileRef.current.value = "";
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  /* ── file handling ─────────────────────────────────────────── */

  const handleFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const parsed = await parseSpreadsheet(file);
        setHeaders(parsed.headers);
        setRows(parsed.rows);
        setSkipped(new Set());
        setEditing(null);
        setPhase("preview");
        setError(null);
      } catch (err) {
        setError(extractError(err));
      }
    },
    [],
  );

  /* ── import ────────────────────────────────────────────────── */

  const handleImport = useCallback(async () => {
    const activeRows = rows.filter((_, i) => !skipped.has(i));
    if (activeRows.length === 0) {
      setError("All rows are skipped — nothing to import.");
      return;
    }
    setPhase("importing");
    setError(null);
    try {
      const csvText = toCsvText(headers, activeRows);
      const res = await importApi(csvText);
      setResult(res);
      setPhase("done");
      if (res.created > 0) onImported();
    } catch (e) {
      setError(extractError(e));
      setPhase("preview");
    }
  }, [headers, rows, skipped, importApi, onImported]);

  /* ── row / cell editing helpers ────────────────────────────── */

  const toggleRow = useCallback(
    (idx: number) => {
      setSkipped((prev) => {
        const next = new Set(prev);
        if (next.has(idx)) next.delete(idx);
        else next.add(idx);
        return next;
      });
    },
    [],
  );

  const toggleAll = useCallback(() => {
    setSkipped((prev) => {
      if (prev.size === 0) return new Set(rows.map((_, i) => i));
      return new Set();
    });
  }, [rows]);

  const setCell = useCallback(
    (rowIdx: number, colIdx: number, value: string) => {
      setRows((prev) => {
        const next = prev.map((r) => [...r]);
        next[rowIdx][colIdx] = value;
        return next;
      });
    },
    [],
  );

  /* ── template download ─────────────────────────────────────── */

  const handleTemplate = useCallback(
    (fmt: "csv" | "xlsx") => {
      const tplCols: TemplateColumn[] = columns.map((c) => ({
        name: c.name,
        required: c.required,
        example: c.example,
      }));
      downloadTemplate(tplCols, templateFilename, fmt);
      setTemplateOpen(false);
    },
    [columns, templateFilename],
  );

  /* ── cell error check ──────────────────────────────────────── */

  const isRequiredMissing = useCallback(
    (header: string, value: string) => {
      const normalized = header.toLowerCase().replace(/\s+/g, "_");
      return (
        requiredCols.includes(normalized) && value.trim().length === 0
      );
    },
    [requiredCols],
  );

  /* ── counts ────────────────────────────────────────────────── */

  const activeCount = rows.length - skipped.size;

  const colDefByHeader = useMemo(() => {
    const map = new Map<string, (typeof columns)[number]>();
    for (const c of columns) {
      map.set(c.name.toLowerCase().replace(/\s+/g, "_"), c);
    }
    return map;
  }, [columns]);

  const cellErrors = useMemo(() => {
    return rows.map((row) =>
      headers.map((h) => {
        const normalized = h.toLowerCase().replace(/\s+/g, "_");
        const col = colDefByHeader.get(normalized);
        const value = row[headers.indexOf(h)] ?? "";
        return validateCell(value, col);
      }),
    );
  }, [rows, headers, colDefByHeader]);

  const issueCount = useMemo(
    () => cellErrors.filter((row, ri) => !skipped.has(ri) && row.some(Boolean)).length,
    [cellErrors, skipped],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/60 backdrop-blur-sm">
      <div className="w-full max-w-4xl rounded-xl border border-border bg-card shadow-2xl">
        {/* ── header ────────────────────────────────────────── */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">{title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          </div>
          <button
            onClick={handleClose}
            className="rounded-md p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-6 py-4">
          {error && (
            <Alert title="Import error" className="mb-4">
              {error}
            </Alert>
          )}

          {/* ── SELECT phase ───────────────────────────────── */}
          {phase === "select" && (
            <div className="space-y-4">
              <div
                onClick={() => fileRef.current?.click()}
                className="flex cursor-pointer flex-col items-center gap-3 rounded-lg border-2 border-dashed border-border p-8 hover:border-primary hover:bg-muted"
              >
                <FileUp className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  Click to select a file, or drag and drop
                </p>
                <p className="text-xs text-muted-foreground">
                  Accepts <code>.csv</code>, <code>.xlsx</code>,{" "}
                  <code>.xls</code>
                </p>
                <p className="text-xs text-muted-foreground">
                  {columns.filter((c) => c.required).map((c) => c.name).join(", ")}{" "}
                  required · {columns.filter((c) => !c.required).length} optional columns supported
                </p>
              </div>

              {/* Template download */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  Need a template?
                </span>
                <div className="relative">
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Download}
                    onClick={() => setTemplateOpen((v) => !v)}
                  >
                    Download template
                  </Button>
                  {templateOpen && (
                    <div className="absolute left-0 top-full z-10 mt-1 flex gap-1 rounded-lg border border-border bg-card p-1 shadow-lg">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleTemplate("csv")}
                      >
                        CSV
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleTemplate("xlsx")}
                      >
                        XLSX
                      </Button>
                    </div>
                  )}
                </div>
              </div>

              <input
                ref={fileRef}
                type="file"
                accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                onChange={(e) => void handleFile(e)}
                className="hidden"
              />
            </div>
          )}

          {/* ── PREVIEW phase ──────────────────────────────── */}
          {phase === "preview" && (
            <div className="space-y-3">
              {/* Summary bar */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-foreground">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-foreground/40" />
                    {rows.length} row{rows.length !== 1 ? "s" : ""}
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 dark:bg-success/20 px-2.5 py-0.5 text-xs font-medium text-success">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-success" />
                    {activeCount} to import
                  </span>
                  {issueCount > 0 && (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-destructive/10 dark:bg-destructive/20 px-2.5 py-0.5 text-xs font-medium text-destructive">
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-destructive" />
                      {issueCount} with issues
                    </span>
                  )}
                  {skipped.size > 0 && (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
                      {skipped.size} skipped
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {requiredCols.length > 0 && (
                    <span className="inline-flex items-center gap-1 text-xs text-warning">
                      <span className="inline-block h-2 w-2 rounded-full bg-warning" />
                      = required
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1 text-xs text-destructive">
                    <span className="inline-block h-2 w-2 rounded-full bg-destructive/40" />
                    = has issue
                  </span>
                </div>
              </div>

              {/* Scrollable table */}
              <div className="max-h-96 overflow-auto rounded-lg border border-border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 z-10">
                    <tr className="border-b border-border bg-muted">
                      <th className="w-10 px-2 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={skipped.size === 0 && rows.length > 0}
                          onChange={toggleAll}
                          className="accent-accent"
                          title="Toggle all rows"
                        />
                      </th>
                      <th className="w-10 px-2 py-2 text-center font-medium text-muted-foreground">
                        #
                      </th>
                      {headers.map((h, i) => {
                        const normalized = h
                          .toLowerCase()
                          .replace(/\s+/g, "_");
                        const isReq = requiredCols.includes(normalized);
                        const displayName = parseHeaderDisplay(h);
                        const colDef = colDefByHeader.get(normalized);
                        const colType = colDef?.type;
                        return (
                          <th
                            key={i}
                            className={cn(
                              "px-3 py-2 text-left font-medium",
                              isReq
                                ? "text-warning"
                                : "text-muted-foreground",
                            )}
                          >
                            <span className="inline-flex items-center gap-1">
                              {displayName}
                              {isReq && (
                                <span className="inline-block h-1.5 w-1.5 rounded-full bg-warning" />
                              )}
                            </span>
                            {colType && colType !== "string" && (
                              <span className="mt-0.5 block text-xs font-normal text-muted-foreground/60">
                                {colType}
                              </span>
                            )}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, ri) => {
                      const isSkipped = skipped.has(ri);
                      const actualRowErrors = headers.reduce((acc, h, ci) => {
                        const val = row[ci] ?? "";
                        const missing = isRequiredMissing(h, val);
                        const errMsg = cellErrors[ri]?.[ci] ?? null;
                        return acc + ((missing || errMsg) ? 1 : 0);
                      }, 0);
                      return (
                        <tr
                          key={ri}
                          className={cn(
                            "border-b border-border transition-colors",
                            isSkipped && "bg-muted/50 opacity-50",
                            !isSkipped && ri % 2 === 1 && "bg-muted/30",
                          )}
                        >
                          {/* Checkbox */}
                          <td className="px-2 py-1.5 text-center">
                            <input
                              type="checkbox"
                              checked={!isSkipped}
                              onChange={() => toggleRow(ri)}
                              className="accent-accent"
                            />
                          </td>
                          {/* Row number */}
                          <td className="px-2 py-1.5 text-center text-muted-foreground">
                            {actualRowErrors > 0 && !isSkipped ? (
                              <span className="inline-flex items-center gap-0.5">
                                {ri + 1}
                                <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive/10 dark:bg-destructive/20 px-1 text-xs font-bold text-destructive">
                                  {actualRowErrors}
                                </span>
                              </span>
                            ) : (
                              ri + 1
                            )}
                          </td>
                          {/* Data cells */}
                          {headers.map((_, ci) => {
                            const val = row[ci] ?? "";
                            const normalized = headers[ci].toLowerCase().replace(/\s+/g, "_");
                            const colDef = colDefByHeader.get(normalized);
                            const isReadonly = colDef?.readonly === true;
                            const missing = isRequiredMissing(
                              headers[ci],
                              val,
                            );
                            const errMsg = cellErrors[ri]?.[ci] ?? null;
                            const hasError = !!(missing || errMsg);
                            const isEdit =
                              !isReadonly &&
                              editing?.row === ri &&
                              editing?.col === ci;

                            return (
                              <td
                                key={ci}
                                className={cn(
                                  "px-3 py-1.5",
                                  hasError && missing && !errMsg
                                    ? "bg-warning/10 dark:bg-warning/20"
                                    : hasError
                                      ? "bg-destructive/10 dark:bg-destructive/20 border border-destructive/20 dark:border-destructive/40"
                                      : "",
                                  isSkipped
                                    ? "text-muted-foreground"
                                    : "text-muted-foreground",
                                )}
                              >
                                {isEdit ? (
                                  <input
                                    autoFocus
                                    className="w-full bg-transparent text-xs text-foreground outline-none ring-1 ring-accent"
                                    value={val}
                                    onChange={(e) =>
                                      setCell(
                                        ri,
                                        ci,
                                        e.target.value,
                                      )
                                    }
                                    onBlur={() =>
                                      setEditing(null)
                                    }
                                    onKeyDown={(e) => {
                                      if (
                                        e.key === "Enter" ||
                                        e.key === "Escape"
                                      )
                                        setEditing(null);
                                    }}
                                  />
                                ) : (
                                  <span
                                    className={cn(
                                      "flex items-center gap-1",
                                      isReadonly
                                        ? "cursor-default"
                                        : "cursor-text",
                                    )}
                                    onClick={
                                      isReadonly
                                        ? undefined
                                        : () =>
                                            setEditing({
                                              row: ri,
                                              col: ci,
                                            })
                                    }
                                  >
                                    <span className="flex-1 truncate">
                                      {val ? val : missing ? (
                                        <span className="inline-flex items-center gap-1 text-warning italic">
                                          <AlertCircle className="h-3 w-3" />
                                          required
                                        </span>
                                      ) : (
                                        <span className="text-muted-foreground/50 italic">
                                          empty
                                        </span>
                                      )}
                                    </span>
                                    {isReadonly ? (
                                      <span title="Auto-generated — cannot edit"><Lock className="h-3 w-3 flex-shrink-0 text-muted-foreground/20" /></span>
                                    ) : errMsg ? (
                                      <span title={errMsg} className="inline-flex">
                                        <AlertCircle
                                          className="h-3 w-3 flex-shrink-0 text-destructive"
                                        />
                                      </span>
                                    ) : (
                                      <Pencil className="h-3 w-3 flex-shrink-0 text-muted-foreground/30" />
                                    )}
                                  </span>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Actions */}
              <div className="flex justify-end gap-2">
                <Button variant="secondary" size="sm" onClick={reset}>
                  Choose different file
                </Button>
                <Button
                  size="sm"
                  onClick={() => void handleImport()}
                  disabled={activeCount === 0 || issueCount > 0}
                >
                  Import {activeCount} item
                  {activeCount !== 1 ? "s" : ""}
                </Button>
              </div>
            </div>
          )}

          {/* ── IMPORTING phase ────────────────────────────── */}
          {phase === "importing" && (
            <div className="flex flex-col items-center gap-3 py-8">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">Importing…</p>
            </div>
          )}

          {/* ── DONE phase ─────────────────────────────────── */}
          {phase === "done" && result && (
            <div className="space-y-4">
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <CheckCircle className="h-5 w-5 text-success" />
                  <span className="text-sm font-medium text-foreground">
                    {result.created} created
                  </span>
                </div>
                {result.skipped > 0 && (
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-5 w-5 text-warning" />
                    <span className="text-sm text-muted-foreground">
                      {result.skipped} skipped
                    </span>
                  </div>
                )}
              </div>

              {result.errors.length > 0 && (
                <div className="max-h-48 overflow-y-auto rounded-lg border border-border">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border bg-muted">
                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                          Row
                        </th>
                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                          Error
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.errors.map((err, i) => (
                        <tr
                          key={i}
                          className="border-b border-border"
                        >
                          <td className="px-3 py-1.5 text-muted-foreground">
                            {err.row}
                          </td>
                          <td className="px-3 py-1.5 text-destructive">
                            {err.message}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="flex justify-end gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={reset}
                >
                  Import more
                </Button>
                <Button size="sm" onClick={handleClose}>
                  Done
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

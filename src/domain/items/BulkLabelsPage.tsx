/**
 * BulkLabelsPage — bulk barcode label generation.
 *
 * Workflow:
 *   1. Pick an item (barcode auto-fills from item.barcode, locked per master plan §7).
 *   2. Tweak the label count + 2 text lines.
 *   3. Choose printer type + label size.
 *   4. Preview the live label on the right.
 *   5. "Add to list" pushes N copies onto the batch.
 *   6. Bottom actions: Preview PDF / Download PDF / Print (window.open blob).
 *
 * Bulk list is component-state (not persisted to DB) — re-decision v1.
 */
import { useEffect, useMemo, useState } from "react";
import { Printer } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { getSetting, listItems, listLabelPrints, recordLabelPrint } from "./api";
import type { Item, LabelPrintRecord } from "../types";
import { ipc } from "../../shell/lib/ipc";
import { BarcodeThumb } from "./BarcodeThumb";
import {
  buildLabelPdfBlob,
  LOCKED_FORMAT,
  printLabelBatch,
  type BatchLabel,
  type PrintConfig,
  type ThermalSize,
  THERMAL_SIZES,
} from "../../pos/print";
import { Skeleton } from "../../components/ui";
import { extractError } from "../../lib/extractError";

type PrinterType = "thermal" | "laser-a4";
type LaserPerSheet = 21 | 65;

const PRINTER_PRESETS: Record<PrinterType, string[]> = {
  thermal: Object.keys(THERMAL_SIZES),
  "laser-a4": ["21", "65"],
};

function configFromSelect(printer: PrinterType, choice: string, labelsPerRow = 1): PrintConfig {
  if (printer === "thermal") {
    return { type: "thermal", size: choice as ThermalSize, labelsPerRow };
  }
  return { type: "laser-a4", perSheet: Number(choice) as LaserPerSheet };
}

function formatFromSelect(printer: PrinterType, choice: string): string {
  return `${printer}-${choice}`;
}

function configFromFormat(format: string): PrintConfig {
  if (format.startsWith("thermal-")) {
    return { type: "thermal", size: format.slice("thermal-".length) as ThermalSize };
  }
  if (format.startsWith("laser-a4-")) {
    return { type: "laser-a4", perSheet: Number(format.slice("laser-a4-".length)) as LaserPerSheet };
  }
  return { type: "thermal", size: "50x25" };
}

interface GeneratedRow {
  id: number; // local key for delete
  label: BatchLabel;
  itemId: number;
  itemName: string;
}

let nextRowId = 1;

export function BulkLabelsPage() {
  const [selectedItemId, setSelectedItemId] = useState<number | "">("");
  const [count, setCount] = useState<number>(1);
  const [line1, setLine1] = useState("");
  const [line2, setLine2] = useState("");
  const [skuOverride, setSkuOverride] = useState("");

  const [printer, setPrinter] = useState<PrinterType>("thermal");
  const [sizeChoice, setSizeChoice] = useState<string>("50x25");
  const [labelsPerRow, setLabelsPerRow] = useState(1);

  const [batch, setBatch] = useState<GeneratedRow[]>([]);
  const [history, setHistory] = useState<LabelPrintRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [shopName, setShopName] = useState("");
  const [defaultMapping, setDefaultMapping] = useState<{ name: string; width_mm: number; height_mm: number } | null>(null);

  // Items query — refetches on every mount + on window focus so the
  // barcode picker always reflects the latest items.barcode values
  // (e.g. after editing an item from ItemList).
  const itemsQuery = useQuery({
    queryKey: ["bulk-labels-items"],
    queryFn: () => listItems({ limit: 500 }),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const items = itemsQuery.data ?? [];
  const loadingItems = itemsQuery.isLoading;
  const itemError = itemsQuery.error ? extractError(itemsQuery.error) : null;

  useEffect(() => {
    let cancelled = false;
    getSetting("shop_name")
      .then((v) => !cancelled && setShopName(v || "")).catch((err: unknown) => console.error("Silent catch replaced:", err));
    Promise.all([
      getSetting("receipt_template").catch(() => ""),
      ipc.getDefaultPrinter("label").catch(() => null),
    ])
      .then(([templateRaw, defaultPrinter]) => {
        if (cancelled) return;
        if (templateRaw) {
          try {
            const tpl = JSON.parse(templateRaw);
            if (tpl.label_line1) setLine1(tpl.label_line1);
            if (tpl.label_line2) setLine2(tpl.label_line2);
          } catch {
            /* ignore corrupt JSON */
          }
        }
        if (defaultPrinter && defaultPrinter.use_case === "label" && defaultPrinter.label_width_mm && defaultPrinter.label_height_mm) {
          const w = defaultPrinter.label_width_mm;
          const h = defaultPrinter.label_height_mm;
          setDefaultMapping({ name: defaultPrinter.name, width_mm: w, height_mm: h });
          const key = `${w}x${h}`;
          if (THERMAL_SIZES[key as keyof typeof THERMAL_SIZES]) {
            setPrinter("thermal");
            setSizeChoice(key as typeof sizeChoice);
          }
        }
      }).catch((err: unknown) => console.error("Silent catch replaced:", err));
    return () => {
      cancelled = true;
    };
  }, []);

  async function loadHistory() {
    setHistoryLoading(true);
    try {
      const rows = await listLabelPrints({ limit: 50 });
      setHistory(rows);
    } catch (e) {
      setActionMsg(`Failed to load print history: ${extractError(e)}`);
    } finally {
      setHistoryLoading(false);
    }
  }

  useEffect(() => {
    void loadHistory();
  }, []);

  const selectedItem = useMemo(
    () => items.find((i) => i.id === selectedItemId) ?? null,
    [items, selectedItemId],
  );

  useEffect(() => {
    if (!selectedItem) {
      setLine1("");
      setLine2("");
      setSkuOverride("");
      return;
    }
    const rawLine1 = shopName || selectedItem.label_line1 || "";
    setLine1(rawLine1.replace(/^"|"$/g, ""));
    const brandPart = selectedItem.brand ?? "";
    const brandName = typeof brandPart === "string" ? brandPart : "";
    setLine2(
      [brandName, selectedItem.name].filter(Boolean).join(" "),
    );
    setSkuOverride(selectedItem.sku_code);
  }, [selectedItem, shopName]);

  // When printer changes, snap size choice to a valid value.
  useEffect(() => {
    const presets = PRINTER_PRESETS[printer];
    if (!presets.includes(sizeChoice)) setSizeChoice(presets[0]);
  }, [printer, sizeChoice]);

  function addToList() {
    if (!selectedItem || !selectedItem.barcode) {
      setActionMsg("Pick an item with a barcode first.");
      return;
    }
    const n = Math.max(1, Math.floor(count));
    const rows: GeneratedRow[] = [];
    for (let i = 0; i < n; i++) {
      rows.push({
        id: nextRowId++,
        label: {
          barcode: selectedItem.barcode!,
          line1: line1.trim() || undefined,
          line2: line2.trim() || undefined,
          sku: skuOverride.trim() || selectedItem.sku_code,
        },
        itemId: selectedItem.id,
        itemName: selectedItem.name,
      });
    }
    setBatch((prev) => [...rows, ...prev]);
    setActionMsg(`Added ${n} label${n === 1 ? "" : "s"} to the batch.`);
  }

  function removeRow(id: number) {
    setBatch((prev) => prev.filter((r) => r.id !== id));
  }

  function clearBatch() {
    setBatch([]);
    setActionMsg("Batch cleared.");
  }

  async function recordCurrentBatch(format: string) {
    const grouped = new Map<number, GeneratedRow & { qty: number }>();
    for (const row of batch) {
      const existing = grouped.get(row.itemId);
      if (existing) {
        existing.qty += 1;
      } else {
        grouped.set(row.itemId, { ...row, qty: 1 });
      }
    }
    await Promise.all(
      Array.from(grouped.values()).map((row) =>
        recordLabelPrint({
          itemId: row.itemId,
          barcode: row.label.barcode,
          qty: row.qty,
          format,
          line1: row.label.line1 ?? null,
          line2: row.label.line2 ?? null,
        }),
      ),
    );
    await loadHistory();
  }

  async function reprint(record: LabelPrintRecord) {
    setBusy(true);
    setActionMsg(null);
    try {
      const labels = Array.from({ length: Math.max(1, record.qty) }, () => ({
        barcode: record.barcode,
        line1: record.line1 ?? undefined,
        line2: record.line2 ?? undefined,
      }));
      await printLabelBatch(labels, configFromFormat(record.format));
      setActionMsg(`Reprinted ${record.qty} label${record.qty === 1 ? "" : "s"} for ${record.itemName}.`);
    } catch (e) {
      setActionMsg(`Failed: ${extractError(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleDownload() {
    if (batch.length === 0) return;
    setBusy(true);
    setActionMsg(null);
    try {
      const cfg = configFromSelect(printer, sizeChoice, labelsPerRow);
      await printLabelBatch(
        batch.map((r) => r.label),
        cfg,
      );
      await recordCurrentBatch(formatFromSelect(printer, sizeChoice));
      setActionMsg(`Downloaded PDF with ${batch.length} label(s).`);
    } catch (e) {
      setActionMsg(`Failed: ${extractError(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handlePreview() {
    if (batch.length === 0) return;
    setBusy(true);
    setActionMsg(null);
    try {
      const cfg = configFromSelect(printer, sizeChoice, labelsPerRow);
      const labels = batch.map((r) => r.label);
      const blob = await buildLabelPdfBlob(labels, cfg);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const url = URL.createObjectURL(blob);
      setPreviewUrl(url);
      setActionMsg(`Preview ready — review before downloading or printing.`);
    } catch (e) {
      setActionMsg(`Failed: ${extractError(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handlePrint() {
    if (batch.length === 0) return;
    setBusy(true);
    setActionMsg(null);
    try {
      const cfg = configFromSelect(printer, sizeChoice, labelsPerRow);
      const labels = batch.map((r) => r.label);
      const blob = await buildLabelPdfBlob(labels, cfg);
      const url = URL.createObjectURL(blob);
      const iframe = document.createElement("iframe");
      iframe.style.display = "none";
      iframe.src = url;
      document.body.appendChild(iframe);
      iframe.onload = () => {
        try {
          iframe.contentWindow?.focus();
          iframe.contentWindow?.print();
        } finally {
          document.body.removeChild(iframe);
          URL.revokeObjectURL(url);
        }
      };
      await recordCurrentBatch(formatFromSelect(printer, sizeChoice));
      setActionMsg(`Sent ${batch.length} label(s) to printer.`);
    } catch (e) {
      setActionMsg(`Failed: ${extractError(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-12">
      {/* LEFT: compose — 5 cols */}
      <section className="space-y-3 rounded-lg border border-border bg-card/60 p-4 lg:col-span-5">
        <header className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">Compose label</h3>
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {LOCKED_FORMAT}
          </span>
        </header>

        {/* Item picker */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Item</label>
          <select
            value={selectedItemId}
            onChange={(e) =>
              setSelectedItemId(e.target.value ? Number(e.target.value) : "")
            }
            className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            disabled={loadingItems}
          >
            <option value="">— Pick an item —</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} ({i.sku_code}){i.barcode ? ` · ${i.barcode}` : " · (no barcode)"}
              </option>
            ))}
          </select>
          {itemError && <p className="text-xs text-destructive">{itemError}</p>}
        </div>

        {/* Count + barcode row */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Count</label>
            <input
              type="number"
              min={1}
              max={500}
              value={count}
              onChange={(e) => setCount(Number(e.target.value) || 1)}
              className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Barcode</label>
            <input
              type="text"
              value={selectedItem?.barcode ?? ""}
              readOnly
              placeholder="(auto from item)"
              className="w-full cursor-not-allowed rounded-md border border-border bg-muted px-2.5 py-2 font-mono text-sm text-muted-foreground"
            />
          </div>
        </div>

        {/* Label text lines */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Line 1</label>
            <input
              type="text"
              value={line1}
              onChange={(e) => setLine1(e.target.value)}
              placeholder="Item name"
              className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Line 2</label>
            <input
              type="text"
              value={line2}
              onChange={(e) => setLine2(e.target.value)}
              placeholder="SKU / size"
              className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>
        </div>

        {/* SKU input */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">SKU</label>
          <input
            type="text"
            value={skuOverride}
            onChange={(e) => setSkuOverride(e.target.value)}
            placeholder={selectedItem?.sku_code ?? "SKU code"}
            className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </div>

        {/* Printer settings */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Printer</label>
            <select
              value={printer}
              onChange={(e) => setPrinter(e.target.value as PrinterType)}
              className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            >
              <option value="thermal">Thermal</option>
              <option value="laser-a4">Laser (A4 sheet)</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {printer === "thermal" ? "Label size" : "Labels per A4"}
            </label>
            <select
              value={sizeChoice}
              onChange={(e) => setSizeChoice(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            >
              {PRINTER_PRESETS[printer].map((p) => (
                <option key={p} value={p}>
                  {printer === "thermal" && THERMAL_SIZES[p as ThermalSize]
                    ? THERMAL_SIZES[p as ThermalSize].label
                    : `${p}${printer === "laser-a4" ? " per sheet" : " mm"}`}
                </option>
              ))}
            </select>
          </div>
          {printer === "thermal" && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Labels per row</label>
              <select
                value={labelsPerRow}
                onChange={(e) => setLabelsPerRow(Number(e.target.value) || 1)}
                className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              >
                {[1, 2, 3, 4].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Live preview */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Preview</label>
          <div className="rounded-lg border border-border bg-background p-4">
            {selectedItem?.barcode ? (
              <div className="flex flex-col items-center gap-1">
                <div className="text-center text-[10px] font-medium leading-tight text-foreground">
                  {line1 || "—"}
                </div>
                <div className="text-center text-[9px] leading-tight text-muted-foreground">
                  {line2 || "—"}
                </div>
                <div className="w-full px-2">
                  <BarcodeThumb
                    value={selectedItem.barcode}
                    containerWidth={200}
                    containerHeight={56}
                  />
                </div>
                <div className="text-center text-[8px] font-mono leading-tight text-muted-foreground">
                  {skuOverride || selectedItem.sku_code}
                </div>
              </div>
            ) : (
              <p className="py-8 text-center text-xs text-muted-foreground">
                Pick an item to preview the label.
              </p>
            )}
          </div>
        </div>

        {/* Add to batch */}
        <button
          type="button"
          onClick={addToList}
          disabled={!selectedItem?.barcode}
          className="btn-primary w-full"
        >
          + Add {count} label{count === 1 ? "" : "s"} to batch
        </button>

        {actionMsg && (
          <p className="rounded bg-muted/50 px-2 py-1 text-xs text-muted-foreground">{actionMsg}</p>
        )}
      </section>

      {/* RIGHT: batch + actions + preview + history — 7 cols */}
      <section className="space-y-4 lg:col-span-7">
        {/* Batch table */}
        <div className="rounded-lg border border-border bg-card/60 p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">
              Batch <span className="text-muted-foreground">({batch.length})</span>
            </h3>
            {batch.length > 0 && (
              <button
                type="button"
                onClick={clearBatch}
                className="rounded border border-border px-2 py-1 text-[10px] text-muted-foreground hover:bg-muted"
              >
                Clear all
              </button>
            )}
          </div>

          <div className="max-h-[220px] overflow-y-auto rounded-md border border-border bg-background">
            {batch.length === 0 ? (
              <p className="p-4 text-center text-xs text-muted-foreground">
                No labels yet — add from the left.
              </p>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 border-b border-border bg-background text-muted-foreground">
                  <tr>
                    <th className="px-2.5 py-1.5 font-medium">Barcode</th>
                    <th className="font-medium">Item</th>
                    <th className="text-right font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {batch.map((row) => (
                    <tr key={row.id} className="border-b border-border hover:bg-muted/50">
                      <td className="px-2.5 py-1.5">
                        <BarcodeThumb
                          value={row.label.barcode}
                          containerWidth={80}
                          containerHeight={28}
                        />
                        <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                          {row.label.barcode}
                        </div>
                      </td>
                      <td className="py-1.5 text-foreground">{row.itemName}</td>
                      <td className="py-1.5 text-right">
                        <button
                          type="button"
                          onClick={() => removeRow(row.id)}
                          className="rounded border border-destructive/20 px-2 py-0.5 text-[10px] text-destructive/80 hover:bg-destructive/10 hover:text-destructive"
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Action buttons */}
          <div className="mt-2.5 grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={handlePreview}
              disabled={batch.length === 0 || busy}
              className="rounded-md border border-border bg-muted px-3 py-2 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            >
              Preview
            </button>
            <button
              type="button"
              onClick={handleDownload}
              disabled={batch.length === 0 || busy}
              className="rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Download PDF
            </button>
            <button
              type="button"
              onClick={handlePrint}
              disabled={batch.length === 0 || busy}
              className="rounded-md border border-border bg-muted px-3 py-2 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            >
              Print
            </button>
          </div>
        </div>

        {/* PDF preview */}
        <div className="rounded-lg border border-border bg-card/60 p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">Verify before print</h3>
            {previewUrl && (
              <button
                type="button"
                onClick={() => {
                  URL.revokeObjectURL(previewUrl);
                  setPreviewUrl(null);
                }}
                className="rounded border border-border px-2 py-1 text-[10px] text-muted-foreground hover:bg-muted"
              >
                Clear
              </button>
            )}
          </div>
          {previewUrl ? (
            <iframe
              src={previewUrl}
              title="Label PDF preview"
              className="h-[380px] w-full rounded-md border border-border bg-background"
            />
          ) : (
            <div className="flex h-[380px] items-center justify-center rounded-md border border-dashed border-border bg-background">
              <p className="text-center text-xs text-muted-foreground">
                Click <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">Preview</span> to
                render the batch here.
              </p>
            </div>
          )}
        </div>

        {/* History */}
        <div className="rounded-lg border border-border bg-card/60 p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">Recent prints</h3>
            <button
              type="button"
              onClick={() => void loadHistory()}
              disabled={historyLoading || busy}
              className="rounded border border-border px-2 py-1 text-[10px] text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            >
              Refresh
            </button>
          </div>
          <div className="max-h-[200px] overflow-y-auto rounded-md border border-border bg-background">
            {historyLoading ? (
              <div role="status" aria-live="polite" aria-label="Loading print history" className="space-y-2 p-3">
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-11/12" />
                <Skeleton className="h-6 w-10/12" />
              </div>
            ) : history.length === 0 ? (
              <p className="p-4 text-center text-xs text-muted-foreground">No print history yet.</p>
            ) : (
              <div className="divide-y divide-border">
                {history.map((row) => (
                  <div key={row.id} className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-muted/50">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-foreground">
                        {row.itemName}
                      </p>
                      <p className="font-mono text-[10px] text-muted-foreground">
                        {row.barcode} · qty {row.qty}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void reprint(row)}
                      disabled={busy}
                      className="inline-flex shrink-0 items-center gap-1 rounded border border-primary/20 px-2 py-1 text-[10px] text-primary/80 hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Printer className="h-3 w-3" />
                      Reprint
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

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
import { listItems } from "./api";
import type { Item } from "../types";
import { BarcodeThumb } from "./BarcodeThumb";
import { printLabelBatch, type BatchLabel, type PrintConfig } from "../../pos/print";

type PrinterType = "thermal" | "laser-a4";
type ThermalSize = "50x25" | "50x50" | "38x25";
type LaserPerSheet = 21 | 65;

const PRINTER_PRESETS: Record<PrinterType, string[]> = {
  thermal: ["50x25", "50x50", "38x25"],
  "laser-a4": ["21", "65"],
};

function configFromSelect(printer: PrinterType, choice: string): PrintConfig {
  if (printer === "thermal") {
    return { type: "thermal", size: choice as ThermalSize };
  }
  return { type: "laser-a4", perSheet: Number(choice) as LaserPerSheet };
}

interface GeneratedRow {
  id: number; // local key for delete
  label: BatchLabel;
  itemId: number;
  itemName: string;
}

let nextRowId = 1;

export function BulkLabelsPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [itemError, setItemError] = useState<string | null>(null);

  const [selectedItemId, setSelectedItemId] = useState<number | "">("");
  const [count, setCount] = useState<number>(1);
  const [line1, setLine1] = useState("");
  const [line2, setLine2] = useState("");

  const [printer, setPrinter] = useState<PrinterType>("thermal");
  const [sizeChoice, setSizeChoice] = useState<string>("50x25");

  const [batch, setBatch] = useState<GeneratedRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  // Load items on mount.
  useEffect(() => {
    let cancelled = false;
    setLoadingItems(true);
    listItems({})
      .then((rows) => !cancelled && setItems(rows))
      .catch((e: unknown) => !cancelled && setItemError(String(e)))
      .finally(() => !cancelled && setLoadingItems(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedItem = useMemo(
    () => items.find((i) => i.id === selectedItemId) ?? null,
    [items, selectedItemId],
  );

  // When the user picks a different item, auto-fill label fields.
  // barcode is locked to item.barcode (per Q1 — no per-label override).
  useEffect(() => {
    if (!selectedItem) {
      setLine1("");
      setLine2("");
      return;
    }
    setLine1(selectedItem.label_line1 ?? selectedItem.name);
    setLine2(
      selectedItem.label_line2 ??
        [selectedItem.sku_code, selectedItem.units_per_pack ? `${selectedItem.units_per_pack} pack` : null]
          .filter(Boolean)
          .join(" · "),
    );
  }, [selectedItem]);

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

  async function handleDownload() {
    if (batch.length === 0) return;
    setBusy(true);
    setActionMsg(null);
    try {
      const cfg = configFromSelect(printer, sizeChoice);
      await printLabelBatch(
        batch.map((r) => r.label),
        cfg,
      );
      setActionMsg(`Downloaded PDF with ${batch.length} label(s).`);
    } catch (e) {
      setActionMsg(`Failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handlePreview() {
    if (batch.length === 0) return;
    setBusy(true);
    setActionMsg(null);
    try {
      const cfg = configFromSelect(printer, sizeChoice);
      // Generate to a Blob, open in a new tab — browsers' built-in PDF viewer.
      const { jsPDF } = await import("jspdf");
      const labels = batch.map((r) => r.label);
      // We can't easily intercept the save() blob, so we re-run the build
      // here using a tiny inline PDF generator that returns a blob.
      const blob = await buildLabelPdfBlob(labels, cfg, jsPDF);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      setActionMsg(`Opened preview with ${batch.length} label(s).`);
    } catch (e) {
      setActionMsg(`Failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handlePrint() {
    if (batch.length === 0) return;
    setBusy(true);
    setActionMsg(null);
    try {
      const cfg = configFromSelect(printer, sizeChoice);
      const { jsPDF } = await import("jspdf");
      const labels = batch.map((r) => r.label);
      const blob = await buildLabelPdfBlob(labels, cfg, jsPDF);
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
      setActionMsg(`Sent ${batch.length} label(s) to printer.`);
    } catch (e) {
      setActionMsg(`Failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* LEFT: composer */}
      <div className="space-y-4 rounded-lg border border-white/10 bg-zinc-900/60 p-4">
        <h3 className="text-sm font-semibold text-zinc-100">Compose label</h3>

        <div className="space-y-2">
          <label className="block text-xs text-zinc-400">Item</label>
          <select
            value={selectedItemId}
            onChange={(e) =>
              setSelectedItemId(e.target.value ? Number(e.target.value) : "")
            }
            className="w-full rounded border border-white/10 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
            disabled={loadingItems}
          >
            <option value="">— Pick an item —</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} ({i.sku_code}){i.barcode ? ` · ${i.barcode}` : " · (no barcode)"}
              </option>
            ))}
          </select>
          {itemError && (
            <p className="text-xs text-red-400">{itemError}</p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <label className="block text-xs text-zinc-400">Label count</label>
            <input
              type="number"
              min={1}
              max={500}
              value={count}
              onChange={(e) => setCount(Number(e.target.value) || 1)}
              className="w-full rounded border border-white/10 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
            />
          </div>
          <div className="space-y-2">
            <label className="block text-xs text-zinc-400">
              Barcode value (locked to item)
            </label>
            <input
              type="text"
              value={selectedItem?.barcode ?? ""}
              readOnly
              placeholder="(select an item)"
              className="w-full cursor-not-allowed rounded border border-white/10 bg-zinc-900 px-2 py-1.5 font-mono text-sm text-zinc-400"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <label className="block text-xs text-zinc-400">Line 1</label>
            <input
              type="text"
              value={line1}
              onChange={(e) => setLine1(e.target.value)}
              placeholder="Item name"
              className="w-full rounded border border-white/10 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
            />
          </div>
          <div className="space-y-2">
            <label className="block text-xs text-zinc-400">Line 2</label>
            <input
              type="text"
              value={line2}
              onChange={(e) => setLine2(e.target.value)}
              placeholder="SKU / size"
              className="w-full rounded border border-white/10 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <label className="block text-xs text-zinc-400">Printer type</label>
            <select
              value={printer}
              onChange={(e) => setPrinter(e.target.value as PrinterType)}
              className="w-full rounded border border-white/10 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
            >
              <option value="thermal">Thermal</option>
              <option value="laser-a4">Laser (A4 sheet)</option>
            </select>
          </div>
          <div className="space-y-2">
            <label className="block text-xs text-zinc-400">
              {printer === "thermal" ? "Label size" : "Labels per A4"}
            </label>
            <select
              value={sizeChoice}
              onChange={(e) => setSizeChoice(e.target.value)}
              className="w-full rounded border border-white/10 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
            >
              {PRINTER_PRESETS[printer].map((p) => (
                <option key={p} value={p}>
                  {p}
                  {printer === "laser-a4" ? " per sheet" : " mm"}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Live preview of the currently composed label. */}
        <div className="space-y-2">
          <label className="block text-xs text-zinc-400">Preview</label>
          <div className="rounded border border-white/10 bg-zinc-950 p-3">
            {selectedItem?.barcode ? (
              <div className="flex flex-col items-center gap-1">
                <BarcodeThumb value={selectedItem.barcode} width={180} height={60} />
                <div className="text-center text-xs text-zinc-200">{line1 || "—"}</div>
                <div className="text-center text-[10px] text-zinc-400">
                  {line2 || "—"}
                </div>
              </div>
            ) : (
              <p className="text-center text-xs text-zinc-500">
                Pick an item to see the label preview.
              </p>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={addToList}
          disabled={!selectedItem?.barcode}
          className="w-full rounded bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
        >
          + Add to list
        </button>

        {actionMsg && (
          <p className="text-xs text-zinc-400">{actionMsg}</p>
        )}
      </div>

      {/* RIGHT: batch table + actions */}
      <div className="space-y-3 rounded-lg border border-white/10 bg-zinc-900/60 p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-100">
            Generated labels ({batch.length})
          </h3>
          {batch.length > 0 && (
            <button
              type="button"
              onClick={clearBatch}
              className="rounded border border-white/10 px-2 py-1 text-xs text-zinc-300 hover:bg-white/5"
            >
              Clear all
            </button>
          )}
        </div>

        <div className="max-h-[400px] overflow-y-auto rounded border border-white/10 bg-zinc-950">
          {batch.length === 0 ? (
            <p className="p-4 text-center text-xs text-zinc-500">
              No labels yet. Compose a label on the left and click "Add to list".
            </p>
          ) : (
            <table className="w-full text-left text-xs">
              <thead className="border-b border-white/10 text-zinc-400">
                <tr>
                  <th className="px-2 py-1.5">Barcode</th>
                  <th className="px-2 py-1.5">Item</th>
                  <th className="px-2 py-1.5">Line 1</th>
                  <th className="px-2 py-1.5">Line 2</th>
                  <th className="px-2 py-1.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {batch.map((row) => (
                  <tr key={row.id} className="border-b border-white/5">
                    <td className="px-2 py-1.5">
                      <BarcodeThumb value={row.label.barcode} width={80} height={28} />
                      <div className="mt-1 font-mono text-[10px] text-zinc-400">
                        {row.label.barcode}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-zinc-200">{row.itemName}</td>
                    <td className="px-2 py-1.5 text-zinc-300">{row.label.line1 ?? "—"}</td>
                    <td className="px-2 py-1.5 text-zinc-400">{row.label.line2 ?? "—"}</td>
                    <td className="px-2 py-1.5 text-right">
                      <button
                        type="button"
                        onClick={() => removeRow(row.id)}
                        className="rounded border border-red-400/30 px-2 py-0.5 text-[10px] text-red-300 hover:bg-red-400/10"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={handlePreview}
            disabled={batch.length === 0 || busy}
            className="rounded border border-white/10 bg-zinc-800 px-3 py-2 text-xs text-zinc-100 hover:bg-zinc-700 disabled:opacity-50"
          >
            Preview PDF
          </button>
          <button
            type="button"
            onClick={handleDownload}
            disabled={batch.length === 0 || busy}
            className="rounded bg-sky-600 px-3 py-2 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-50"
          >
            Download PDF
          </button>
          <button
            type="button"
            onClick={handlePrint}
            disabled={batch.length === 0 || busy}
            className="rounded border border-white/10 bg-zinc-800 px-3 py-2 text-xs text-zinc-100 hover:bg-zinc-700 disabled:opacity-50"
          >
            Print
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Build a label PDF identical to printLabelBatch but return a Blob
 * instead of triggering save(), so the caller can open it in a new
 * tab (preview) or load it into a hidden iframe (print).
 */
async function buildLabelPdfBlob(
  batch: BatchLabel[],
  config: PrintConfig,
  jsPDFCtor: typeof import("jspdf").jsPDF,
): Promise<Blob> {
  // We duplicate printLabelBatch's layout here because printLabelBatch
  // always calls save() — Tauri would treat that as a download.
  const JsBarcode = (await import("jsbarcode")).default;
  const renderPng = (value: string): string => {
    const c = document.createElement("canvas");
    JsBarcode(c, value, { format: "CODE128", displayValue: false, margin: 1, height: 40 });
    return c.toDataURL("image/png");
  };

  let doc: import("jspdf").jsPDF;
  if (config.type === "thermal") {
    const SIZE: Record<string, [number, number]> = {
      "50x25": [50, 25],
      "50x50": [50, 50],
      "38x25": [38, 25],
    };
    const [w, h] = SIZE[config.size];
    doc = new jsPDFCtor({ unit: "mm", format: [w, h], orientation: "landscape" });
    const fontSize = h <= 25 ? 7 : 9;
    for (let i = 0; i < batch.length; i++) {
      if (i > 0) doc.addPage([w, h], "landscape");
      const label = batch[i];
      const bcW = Math.min(h - 4, w * 0.55);
      const bcH = h - 6;
      doc.addImage(renderPng(label.barcode), "PNG", 2, 3, bcW, bcH);
      doc.setFontSize(fontSize);
      if (label.line1) doc.text(label.line1.slice(0, 30), bcW + 4, h / 2 - 2);
      if (label.line2) doc.text(label.line2.slice(0, 30), bcW + 4, h / 2 + 2);
    }
  } else {
    const layouts = {
      21: { cols: 3, rows: 7, w: 70, h: 37 },
      65: { cols: 5, rows: 13, w: 38, h: 21 },
    } as const;
    const layout = layouts[config.perSheet];
    doc = new jsPDFCtor({ unit: "mm", format: "a4", orientation: "portrait" });
    doc.setFontSize(7);
    for (let i = 0; i < batch.length; i++) {
      const onPage = i % config.perSheet;
      if (i > 0 && onPage === 0) doc.addPage();
      const label = batch[i];
      const col = onPage % layout.cols;
      const row = Math.floor(onPage / layout.cols);
      const x = col * layout.w;
      const y = row * layout.h;
      const bcW = layout.w - 4;
      const bcH = layout.h - 8;
      doc.addImage(renderPng(label.barcode), "PNG", x + 2, y + 2, bcW, bcH);
      if (label.line1) doc.text(label.line1.slice(0, 22), x + 2, y + layout.h - 4);
      if (label.line2) doc.text(label.line2.slice(0, 22), x + 2, y + layout.h - 1);
    }
  }
  return doc.output("blob");
}
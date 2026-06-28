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
import { useEffect, useMemo, useRef, useState } from "react";
import { Printer } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { getSetting, listItems, listLabelPrints, recordLabelPrint } from "../domain/items/api";
import type { LabelPrintRecord } from "../domain/types";
import { ipc } from "../shell/lib/ipc";
import { BarcodeThumb } from "../components/ui/BarcodeThumb";
import { Select } from "../components/ui/Select";
import {
  LOCKED_FORMAT,
  printLabelBatch,
  type BatchLabel,
  type PrintConfig,
  type ThermalSize,
  THERMAL_SIZES,
} from "../pos/print";
import { buildTsplBytes, buildTsplString, calcLabelCapacity, calcOptimalFont, calcOptimalFontFill } from "../pos/tspl";
import { TsplLabelPreview } from "../pos/TsplLabelPreview";
import { DEFAULT_TSPL_CONFIG, type TsplConfig } from "../pos/tsplConfig";
import { Button, Skeleton } from "../components/ui";
import { useShortcut } from "../lib/shortcuts";
import { useFocusShortcut } from "../lib/shortcuts/useFocusShortcut";
import { extractError } from "../lib/extractError";
import { generateSimpleSequence, type SequenceType } from "./sequence";

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
  itemId?: number; // undefined for custom (non-item) labels
  itemName: string;
}

let nextRowId = 1; // ponytail: module-level for simplicity; reset on remount is acceptable for batch UI

export function BulkLabelsPage() {
  const [selectedItemId, setSelectedItemId] = useState<number | "">("");
  const [count, setCount] = useState<number>(1);
  const [line1, setLine1] = useState("");
  const [line2, setLine2] = useState("");
  const [skuOverride, setSkuOverride] = useState("");

  const [printer, setPrinter] = useState<PrinterType>("thermal");
  const [sizeChoice, setSizeChoice] = useState<string>("50x25");
  const [labelsPerRow, setLabelsPerRow] = useState(1);

  const [tsplConfig, setTsplConfig] = useState<TsplConfig>(DEFAULT_TSPL_CONFIG);

  function updateTsplConfig(updater: (c: TsplConfig) => TsplConfig) {
    setTsplConfig((prev) => {
      const next = updater(prev);
      ipc.setSetting("label.tspl_config", JSON.stringify(next)).catch(() => {});
      return next;
    });
  }

  const [batch, setBatch] = useState<GeneratedRow[]>([]);
  const [history, setHistory] = useState<LabelPrintRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [shopName, setShopName] = useState("");
  const [defaultPrinterName, setDefaultPrinterName] = useState<string | null>(null);
  const [hasPrintedBatch, setHasPrintedBatch] = useState(false);

  const [itemSearchQuery, setItemSearchQuery] = useState("");
  const [showItemDropdown, setShowItemDropdown] = useState(false);
  const itemDropdownRef = useRef<HTMLDivElement>(null);

  // Sub-tabs: items vs custom
  const [activeTab, setActiveTab] = useState<"items" | "custom">("items");

  // Custom label state
  const [customMode, setCustomMode] = useState<"freetext" | "sequence">("freetext");
  const [customText, setCustomText] = useState("");
  const [customCount, setCustomCount] = useState(1);
  // Sequence fields
  const [seqType, setSeqType] = useState<SequenceType>("numeric");
  const [seqPrefix, setSeqPrefix] = useState("");
  const [seqSuffix, setSeqSuffix] = useState("");
  const [seqStart, setSeqStart] = useState(1);
  const [seqCount, setSeqCount] = useState(10);

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
    getSetting("label.tspl_config").then((raw) => {
      if (!raw || cancelled) return;
      try {
        const saved = JSON.parse(raw) as Partial<TsplConfig>;
        setTsplConfig((prev) => ({ ...prev, ...saved }));
      } catch { /* ignore corrupt */ }
    }).catch(() => {});

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
        if (defaultPrinter && defaultPrinter.use_case === "label") {
          setDefaultPrinterName(defaultPrinter.name);
          if (defaultPrinter.label_width_mm && defaultPrinter.label_height_mm) {
            const key = `${defaultPrinter.label_width_mm}x${defaultPrinter.label_height_mm}`;
            if (THERMAL_SIZES[key as keyof typeof THERMAL_SIZES]) {
              setPrinter("thermal");
              setSizeChoice(key as typeof sizeChoice);
            }
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

  useFocusShortcut({ key: "F2", selector: '[data-shortcut="item-picker"]', description: "Focus item picker" });
  useShortcut({ key: "F5", scope: "page", description: "Refresh history", onMatch: () => { void loadHistory(); } });
  useShortcut({
    key: "F6",
    scope: "page",
    description: "Add to batch",
    onMatch: () => {
      if (selectedItem?.barcode) addToList();
    },
  });

  const selectedItem = useMemo(
    () => items.find((i) => i.id === selectedItemId) ?? null,
    [items, selectedItemId],
  );

  const filteredItems = useMemo(() => {
    const q = itemSearchQuery.toLowerCase().trim();
    if (!q) return items;
    return items.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        i.sku_code.toLowerCase().includes(q) ||
        (i.barcode && i.barcode.toLowerCase().includes(q)),
    );
  }, [items, itemSearchQuery]);

  useEffect(() => {
    if (!showItemDropdown) return;
    const handler = (e: MouseEvent) => {
      if (itemDropdownRef.current && !itemDropdownRef.current.contains(e.target as Node)) {
        setShowItemDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showItemDropdown]);

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

  // Save/restore labelsPerRow across printer type switches.
  const savedLabelsPerRowRef = useRef(1);
  useEffect(() => {
    const presets = PRINTER_PRESETS[printer];
    if (!presets.includes(sizeChoice)) setSizeChoice(presets[0]);
    // Restore labelsPerRow when switching back to thermal.
    if (printer === "thermal") {
      setLabelsPerRow(savedLabelsPerRowRef.current || 1);
    }
  }, [printer, sizeChoice]);
  // Snapshot labelsPerRow whenever it changes while on thermal.
  useEffect(() => {
    if (printer === "thermal") savedLabelsPerRowRef.current = labelsPerRow;
  }, [labelsPerRow, printer]);

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
    setHasPrintedBatch(false);
    setActionMsg(`Added ${n} label${n === 1 ? "" : "s"} to the batch.`);
  }

  function removeRow(id: number) {
    setBatch((prev) => prev.filter((r) => r.id !== id));
    setHasPrintedBatch(false);
  }

  function clearBatch() {
    setBatch([]);
    setHasPrintedBatch(false);
    setActionMsg("Batch cleared.");
  }

  function addCustomFreeText() {
    if (!customText.trim()) return;
    const n = Math.max(1, Math.floor(customCount));
    const rawLines = customText.split("\n").map((l) => l.trim()).filter(Boolean);
    const lines3: [string, string, string] = [
      rawLines[0] || "",
      rawLines[1] || "",
      rawLines.slice(2).join(" ") || "",
    ];
    const rows: GeneratedRow[] = [];
    for (let i = 0; i < n; i++) {
      rows.push({
        id: nextRowId++,
        label: {
          line1: lines3[0] || undefined,
          line2: lines3[1] || undefined,
          line3: lines3[2] || undefined,
        },
        itemName: "Custom",
      });
    }
    setBatch((prev) => [...rows, ...prev]);
    setHasPrintedBatch(false);
    setActionMsg(`Added ${n} custom label${n === 1 ? "" : "s"} to the batch.`);
  }

  function addCustomSequence() {
    const texts = generateSimpleSequence({
      type: seqType,
      prefix: seqPrefix,
      suffix: seqSuffix,
      start: seqStart,
      count: Math.max(1, Math.floor(seqCount)),
    });
    const rows: GeneratedRow[] = texts.map((text) => ({
      id: nextRowId++,
      label: { line1: text || undefined },
      itemName: "Custom",
    }));
    setBatch((prev) => [...rows, ...prev]);
    setHasPrintedBatch(false);
    setActionMsg(`Added ${rows.length} sequence label${rows.length === 1 ? "" : "s"} to the batch.`);
  }

  async function recordCurrentBatch(format: string) {
    const itemRows = batch.filter((r) => r.itemId != null);
    if (itemRows.length === 0) return;
    const grouped = new Map<number, GeneratedRow & { qty: number }>();
    for (const row of itemRows) {
      const id = row.itemId!;
      const existing = grouped.get(id);
      if (existing) {
        existing.qty += 1;
      } else {
        grouped.set(id, { ...row, qty: 1 });
      }
    }
    const tsplJson = JSON.stringify(tsplConfig);
    await Promise.all(
      Array.from(grouped.values()).map((row) =>
        recordLabelPrint({
          itemId: row.itemId!,
          barcode: row.label.barcode ?? "",
          qty: row.qty,
          format,
          line1: row.label.line1 ?? null,
          line2: row.label.line2 ?? null,
          tsplConfig: tsplJson,
          printer,
          labelSize: sizeChoice,
          labelsPerRow,
        }),
      ),
    );
    await loadHistory();
  }

  async function reprint(record: LabelPrintRecord) {
    setBusy(true);
    setActionMsg(null);
    try {
      const recTspl = record.tsplConfig ? (JSON.parse(record.tsplConfig) as typeof tsplConfig) : tsplConfig;
      const recSize = record.labelSize || sizeChoice;
      const recPrinter = record.printer || printer;
      const recCols = record.labelsPerRow ?? labelsPerRow;

      const isTauriApp =
        typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
      if (isTauriApp && defaultPrinterName) {
        try {
          const selectedSize = THERMAL_SIZES[recSize as keyof typeof THERMAL_SIZES];
          if (!selectedSize) throw new Error(`Unknown label size: ${recSize}`);
          const { w: widthMm, h: heightMm } = selectedSize;
          const reprintLabel = { barcode: record.barcode, line1: record.line1 ?? undefined, line2: record.line2 ?? undefined };
          const cols = recPrinter === "thermal" ? Math.max(1, recCols) : 1;
          // Fill every cell of the strip with the same label; use PRINT stripsNeeded,1.
          const strip = Array.from({ length: cols }, () => reprintLabel);
          const stripsNeeded = Math.ceil(Math.max(1, record.qty) / cols);
          const bytes = buildTsplBytes(strip, widthMm, heightMm, cols, stripsNeeded, recTspl);
          await ipc.printRaw(defaultPrinterName, bytes);
          setActionMsg(`Reprinted ${record.qty} label${record.qty === 1 ? "" : "s"} for ${record.itemName}.`);
          return;
        } catch (rawErr) {
          console.warn("TSPL reprint failed, falling back to PDF:", rawErr);
        }
      }

      // Fallback — PDF download.
      const labels = Array.from({ length: Math.max(1, record.qty) }, () => ({
        barcode: record.barcode,
        line1: record.line1 ?? undefined,
        line2: record.line2 ?? undefined,
      }));
      const reprintCfg = configFromFormat(record.format);
      if (reprintCfg.type === "thermal") reprintCfg.labelsPerRow = record.labelsPerRow ?? labelsPerRow;
      await printLabelBatch(labels, reprintCfg);
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
      if (!hasPrintedBatch) await recordCurrentBatch(formatFromSelect(printer, sizeChoice));
      setHasPrintedBatch(true);
      setActionMsg(`Downloaded PDF with ${batch.length} label(s).`);
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
      const isTauriApp =
        typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

      // TSPL raw-print path — send TSPL bytes via Win32 WritePrinter.
      // Dimensions come from the page's sizeChoice dropdown, not from
      // the printer record (the user selects the label size on this page).
      if (isTauriApp && defaultPrinterName) {
        try {
          const selectedSize = THERMAL_SIZES[sizeChoice as keyof typeof THERMAL_SIZES];
          if (!selectedSize) throw new Error(`Unknown label size: ${sizeChoice}`);
          const { w: widthMm, h: heightMm } = selectedSize;
          const cols = printer === "thermal" ? Math.max(1, labelsPerRow) : 1;
          const flatLabels = batch.map((r) => r.label);

          if (cols === 1) {
            // Run-length encode consecutive identical labels so PRINT qty,1 is used
            // for repeated copies of the same label. All strips go into ONE print job
            // (one printRaw call) to avoid spooler flooding that causes empty labels.
            function labelKey(l: BatchLabel): string {
              return `${l.barcode ?? ""}\x00${l.line1 ?? ""}\x00${l.line2 ?? ""}\x00${l.line3 ?? ""}`;
            }
            const runs: { label: BatchLabel; qty: number }[] = [];
            for (const l of flatLabels) {
              const key = labelKey(l);
              const last = runs.at(-1);
              if (last && labelKey(last.label) === key) {
                last.qty++;
              } else {
                runs.push({ label: l, qty: 1 });
              }
            }
            const bytes = buildTsplBytes(
              runs.map((r) => r.label),
              widthMm, heightMm, 1,
              runs.map((r) => r.qty),
              tsplConfig,
            );
            await ipc.printRaw(defaultPrinterName, bytes);
          } else {
            // Multi-column: chunk batch into strips of `cols` labels, one job per strip.
            // SIZE stays at physical roll width (widthMm); cells are rollWidth/cols each.
            for (let i = 0; i < flatLabels.length; i += cols) {
              const strip = flatLabels.slice(i, i + cols);
              const bytes = buildTsplBytes(strip, widthMm, heightMm, cols, 1, tsplConfig);
              await ipc.printRaw(defaultPrinterName, bytes);
            }
          }

          if (!hasPrintedBatch) await recordCurrentBatch(formatFromSelect(printer, sizeChoice));
          setHasPrintedBatch(true);
          setActionMsg(`Sent ${batch.length} label(s) to ${defaultPrinterName}.`);
          return;
        } catch (rawErr) {
          console.warn("TSPL raw print failed, falling back to PDF:", rawErr);
        }
      }

      // Fallback — download PDF (also used when no default label printer).
      const cfg = configFromSelect(printer, sizeChoice, labelsPerRow);
      await printLabelBatch(batch.map((r) => r.label), cfg);
      if (!hasPrintedBatch) await recordCurrentBatch(formatFromSelect(printer, sizeChoice));
      setHasPrintedBatch(true);
      setActionMsg(
        defaultPrinterName
          ? "Direct thermal print unavailable on this platform — PDF downloaded instead."
          : "No default label printer configured — PDF downloaded.",
      );
    } catch (e) {
      setActionMsg(`Failed: ${extractError(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const thermalSize = printer === "thermal" ? THERMAL_SIZES[sizeChoice as keyof typeof THERMAL_SIZES] : null;
  const rollW = thermalSize?.w ?? 100;
  const rollH = thermalSize?.h ?? 50;
  const cols = printer === "thermal" ? Math.max(1, labelsPerRow) : 1;
  const labelCapacity = useMemo(() => calcLabelCapacity(rollW, rollH, cols, tsplConfig), [rollW, rollH, cols, tsplConfig]);

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

        <div className="flex gap-1 rounded-md border border-border p-0.5">
          <button type="button" onClick={() => setActiveTab("items")}
            className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${activeTab === "items" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            Items
          </button>
          <button type="button" onClick={() => setActiveTab("custom")}
            className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${activeTab === "custom" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            Custom
          </button>
        </div>

        {/* Item picker */}
        {activeTab === "items" && (
        <>
        <div className="space-y-1.5" ref={itemDropdownRef}>
          <label className="text-xs font-medium text-muted-foreground">Item</label>
          <div className="relative">
            <input
              type="search"
              data-shortcut="item-picker"
              className="input w-full"
              placeholder={loadingItems ? "Loading items…" : "Search by name, SKU, or barcode…"}
              value={showItemDropdown ? itemSearchQuery : (selectedItem ? `${selectedItem.name}${selectedItem.barcode ? ` · ${selectedItem.barcode}` : ""}` : itemSearchQuery)}
              onChange={(e) => {
                setItemSearchQuery(e.target.value);
                setShowItemDropdown(true);
              }}
              onFocus={() => {
                setShowItemDropdown(true);
                setItemSearchQuery("");
              }}
              onKeyDown={(e) => {
                if (!showItemDropdown || filteredItems.length === 0) return;
                const curIdx = filteredItems.findIndex((i) => i.id === selectedItemId);
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  const next = curIdx < filteredItems.length - 1 ? curIdx + 1 : 0;
                  setSelectedItemId(filteredItems[next].id);
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  const prev = curIdx > 0 ? curIdx - 1 : filteredItems.length - 1;
                  setSelectedItemId(filteredItems[prev].id);
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (curIdx >= 0) {
                    setItemSearchQuery("");
                    setShowItemDropdown(false);
                  }
                } else if (e.key === "Escape") {
                  setShowItemDropdown(false);
                }
              }}
              disabled={loadingItems}
            />
            {showItemDropdown && (
              <div className="absolute z-50 mt-1 w-full max-h-60 overflow-y-auto rounded-md border bg-popover shadow-md">
                {filteredItems.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-muted-foreground">
                    {items.length === 0 ? "No items found" : "No matches"}
                  </div>
                ) : (
                  filteredItems.map((i) => {
                    const inBatch = batch.filter((r) => r.itemId === i.id).length;
                    return (
                    <button
                      key={i.id}
                      type="button"
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer ${
                        i.id === selectedItemId ? "bg-accent text-accent-foreground" : ""
                      }`}
                      onClick={() => {
                        setSelectedItemId(i.id);
                        setItemSearchQuery("");
                        setShowItemDropdown(false);
                      }}
                    >
                      <span>{i.name}{i.barcode ? ` · ${i.barcode}` : ""}</span>
                      {inBatch > 0 && (
                        <span className="ml-1.5 inline-block rounded bg-primary/15 px-1 text-[10px] font-medium text-primary">
                          {inBatch} in batch
                        </span>
                      )}
                    </button>
                    );
                  })
                )}
              </div>
            )}
          </div>
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
        </>
        )}

        {activeTab === "custom" && (
        <>
        <div className="flex gap-1 rounded-md border border-border p-0.5">
          <button type="button" onClick={() => setCustomMode("freetext")}
            className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${customMode === "freetext" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            Free Text
          </button>
          <button type="button" onClick={() => setCustomMode("sequence")}
            className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${customMode === "sequence" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            Sequence
          </button>
        </div>

        {customMode === "freetext" && (() => {
          const rawLines = customText.split("\n").map((l) => l.trim()).filter(Boolean);
          let totalWrapped = 0;
          let overflow = false;
          for (const line of rawLines) {
            const wrapped = Math.max(1, Math.ceil(line.length / labelCapacity.maxCharsPerLine));
            totalWrapped += wrapped;
            if (line.length > labelCapacity.maxCharsPerLine) overflow = true;
          }
          if (totalWrapped > labelCapacity.maxLines) overflow = true;
          const textOverflows = overflow && customText.trim().length > 0;
          return (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Text</label>
              <textarea
                value={customText}
                onChange={(e) => setCustomText(e.target.value)}
                placeholder="Type label text here... (each line becomes a label line)"
                rows={4}
                className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 resize-none"
              />
              <p className="text-[10px] text-muted-foreground">
                Capacity: {labelCapacity.maxCharsPerLine} chars/line, {labelCapacity.maxLines} lines max at font {tsplConfig.font}
              </p>
              {textOverflows && (
                <p className="text-[10px] text-destructive">
                  Text exceeds label capacity ({labelCapacity.maxCharsPerLine} chars/line, {labelCapacity.maxLines} lines max)
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Count</label>
              <input type="number" min={1} max={500} value={customCount}
                onChange={(e) => setCustomCount(Number(e.target.value) || 1)}
                className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
            </div>
          </div>
          );
        })()}

        {customMode === "sequence" && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Sequence type</label>
              <Select value={seqType}
                onChange={(e) => setSeqType(e.target.value as SequenceType)}
                options={[
                  { value: "numeric", label: "Numbers (1, 2, 3...)" },
                  { value: "lowercase", label: "Lowercase (a, b, c...)" },
                  { value: "uppercase", label: "Uppercase (A, B, C...)" },
                ]} size="md" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Prefix</label>
                <input type="text" value={seqPrefix} onChange={(e) => setSeqPrefix(e.target.value)}
                  placeholder="e.g. SKU-"
                  className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Suffix</label>
                <input type="text" value={seqSuffix} onChange={(e) => setSeqSuffix(e.target.value)}
                  placeholder="e.g. -A"
                  className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Start</label>
                <input type="number" min={1} value={seqStart}
                  onChange={(e) => setSeqStart(Number(e.target.value) || 1)}
                  className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Count</label>
                <input type="number" min={1} max={500} value={seqCount}
                  onChange={(e) => setSeqCount(Number(e.target.value) || 1)}
                  className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
              </div>
            </div>
          </div>
        )}
        </>
        )}

        {/* Printer settings */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Printer</label>
            <Select
              value={printer}
              onChange={(e) => setPrinter(e.target.value as PrinterType)}
              options={[
                { value: "thermal", label: "Thermal" },
                { value: "laser-a4", label: "Laser (A4 sheet)" },
              ]}
              size="md"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {printer === "thermal" ? "Label size" : "Labels per A4"}
            </label>
            <Select
              value={sizeChoice}
              onChange={(e) => setSizeChoice(e.target.value)}
              options={PRINTER_PRESETS[printer].map((p) => ({
                value: String(p),
                label:
                  printer === "thermal" && THERMAL_SIZES[p as ThermalSize]
                    ? THERMAL_SIZES[p as ThermalSize].label
                    : `${p}${printer === "laser-a4" ? " per sheet" : " mm"}`,
              }))}
              size="md"
            />
          </div>
          {printer === "thermal" && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Labels per row</label>
              <Select
                value={String(labelsPerRow)}
                onChange={(e) => setLabelsPerRow(Number(e.target.value) || 1)}
                options={[1, 2, 3, 4].map((value) => ({
                  value: String(value),
                  label: String(value),
                }))}
                size="md"
              />
            </div>
          )}
        </div>

        {/* Label configurator + live TSPL preview */}
        {(() => {
          const cellWmm = rollW / cols;
          const previewW = 300;
          const previewH = Math.round(previewW * (rollH / cellWmm));

          function Spinner({
            label, value, step, min, max, unit = "mm", onChange,
          }: { label: string; value: number; step: number; min: number; max: number; unit?: string; onChange: (v: number) => void }) {
            const clamp = (v: number) => Math.round(Math.min(max, Math.max(min, v)) * 10) / 10;
            return (
              <div className="space-y-1">
                <span className="text-[10px] font-medium text-muted-foreground">{label}</span>
                <div className="flex items-center">
                  <button type="button" onClick={() => onChange(clamp(value - step))}
                    className="flex h-7 w-7 items-center justify-center rounded-l border border-border bg-muted text-sm font-bold text-muted-foreground hover:text-foreground active:scale-95">−</button>
                  <input
                    type="number" value={value} step={step} min={min} max={max}
                    onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) onChange(clamp(v)); }}
                    className="h-7 w-14 border-y border-border bg-background text-center font-mono text-xs text-foreground outline-none focus:border-primary"
                  />
                  <button type="button" onClick={() => onChange(clamp(value + step))}
                    className="flex h-7 w-7 items-center justify-center rounded-r border border-border bg-muted text-sm font-bold text-muted-foreground hover:text-foreground active:scale-95">+</button>
                  {unit && <span className="ml-1.5 text-[10px] text-muted-foreground">{unit}</span>}
                </div>
              </div>
            );
          }

          function autoFit() {
            if (customMode === "freetext") {
              // Free text: pick largest font by height, wordWrap handles width
              const text = customText.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
              if (!text) return;
              const usableW = Math.floor((rollW * 8) / cols) - Math.round(tsplConfig.sideMarginMm * 8) * 2;
              const availH = Math.max(0, rollH * 8 - Math.round(tsplConfig.topMarginMm * 8));
              const opt = calcOptimalFont(text, usableW, availH);
              updateTsplConfig((c) => ({ ...c, font: opt.font, xmul: opt.xmul, ymul: opt.ymul }));
            } else {
              // Sequence: fill entire label with the longest sequence entry
              const seq = generateSimpleSequence({ type: seqType, prefix: seqPrefix, suffix: seqSuffix, start: seqStart, count: Math.max(seqCount, 1) });
              const text = seq[seq.length - 1] ?? "";
              if (!text) return;
              const usableW = Math.floor((rollW * 8) / cols) - Math.round(tsplConfig.sideMarginMm * 8) * 2;
              const availH = Math.max(0, rollH * 8 - Math.round(tsplConfig.topMarginMm * 8));
              const opt = calcOptimalFontFill(text, usableW, availH);
              updateTsplConfig((c) => ({ ...c, font: opt.font, xmul: opt.xmul, ymul: opt.ymul }));
            }
          }

          return (
            <div className="space-y-3 rounded-lg border border-border bg-background p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-foreground">
                  Label configurator
                  <span className="ml-1.5 font-normal text-muted-foreground">{cellWmm} × {rollH} mm</span>
                </span>
                <button type="button" onClick={() => updateTsplConfig(() => DEFAULT_TSPL_CONFIG)}
                  className="text-[10px] text-muted-foreground hover:text-foreground">Reset</button>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Spinner
                  label="Font (2–5)" value={Number(tsplConfig.font)} step={1} min={2} max={5} unit=""
                  onChange={(v) => updateTsplConfig((c) => ({ ...c, font: String(Math.round(v)) as TsplConfig["font"] }))}
                />
                <Spinner
                  label="Size ×" value={tsplConfig.xmul} step={1} min={1} max={10} unit=""
                  onChange={(v) => updateTsplConfig((c) => ({ ...c, xmul: v, ymul: v }))}
                />
                <div className="space-y-1">
                  <span className="text-[10px] font-medium text-muted-foreground">Auto-fit</span>
                  <button type="button" onClick={autoFit}
                    className="flex h-7 items-center rounded border border-border bg-muted px-2 text-[10px] font-semibold text-muted-foreground hover:text-foreground active:scale-95">Auto</button>
                </div>
                <Spinner
                  label="Spacing" value={tsplConfig.spacingMm} step={0.5} min={0} max={10}
                  onChange={(v) => updateTsplConfig((c) => ({ ...c, spacingMm: v }))}
                />
                <Spinner
                  label="Top margin" value={tsplConfig.topMarginMm} step={0.5} min={0} max={30}
                  onChange={(v) => updateTsplConfig((c) => ({ ...c, topMarginMm: v }))}
                />
                <Spinner
                  label="Side margin" value={tsplConfig.sideMarginMm} step={0.5} min={0} max={15}
                  onChange={(v) => updateTsplConfig((c) => ({ ...c, sideMarginMm: v }))}
                />
              </div>

              <div className="flex justify-center pt-1">
                {(() => {
                  const customPreviewLabel = customMode === "sequence"
                    ? (() => {
                        const texts = generateSimpleSequence({ type: seqType, prefix: seqPrefix, suffix: seqSuffix, start: seqStart, count: 1 });
                        return texts[0] ? { line1: texts[0] } : null;
                      })()
                    : (() => {
                        const lines = customText.split("\n").map((l) => l.trim()).filter(Boolean);
                        return {
                          line1: lines[0] || undefined,
                          line2: lines[1] || undefined,
                          line3: lines.slice(2).join(" ") || undefined,
                        };
                      })();
                  const previewLabel = activeTab === "items"
                    ? (selectedItem?.barcode ? { barcode: selectedItem.barcode, line1: line1.trim() || undefined, line2: line2.trim() || undefined } : null)
                    : customPreviewLabel;
                  if (previewLabel) {
                    return (
                      <TsplLabelPreview
                        label={previewLabel}
                        rollWidthMm={rollW} heightMm={rollH} labelsPerRow={cols}
                        config={tsplConfig} displayWidth={previewW}
                      />
                    );
                  }
                  return (
                    <div style={{ width: previewW, height: previewH }}
                      className="flex items-center justify-center rounded border border-dashed border-border bg-muted/30">
                      <p className="text-xs text-muted-foreground">{activeTab === "items" ? "Pick an item to preview" : "Enter text to preview"}</p>
                    </div>
                  );
                })()}
              </div>

              {/* Raw TSPL viewer — shows exactly what gets sent to the printer */}
              {(() => {
                const rawLabel = activeTab === "items"
                  ? (selectedItem?.barcode ? { barcode: selectedItem.barcode, line1: line1.trim() || undefined, line2: line2.trim() || undefined } : null)
                  : (() => {
                      if (customMode === "sequence") {
                        const texts = generateSimpleSequence({ type: seqType, prefix: seqPrefix, suffix: seqSuffix, start: seqStart, count: 1 });
                        return texts[0] ? { line1: texts[0] } : null;
                      }
                      const lines = customText.split("\n").map((l) => l.trim()).filter(Boolean);
                      if (!lines.length) return null;
                      return {
                        line1: lines[0] || undefined,
                        line2: lines[1] || undefined,
                        line3: lines.slice(2).join(" ") || undefined,
                      };
                    })();
                if (!rawLabel) return null;
                return (
                  <details className="group">
                    <summary className="cursor-pointer select-none text-[10px] text-muted-foreground hover:text-foreground">
                      Raw TSPL ▸
                    </summary>
                    <pre className="mt-1 max-h-48 overflow-auto rounded border border-border bg-muted/30 p-2 font-mono text-[10px] text-foreground leading-relaxed">
                      {buildTsplString(
                        [rawLabel],
                        rollW, rollH, cols, tsplConfig,
                      )}
                    </pre>
                  </details>
                );
              })()}
            </div>
          );
        })()}

        {/* Add to batch */}
        {activeTab === "items" && (
          <Button
            type="button"
            variant="primary"
            onClick={addToList}
            disabled={!selectedItem?.barcode}
            shortcut="F6"
            className="w-full"
          >
            + Add {count} label{count === 1 ? "" : "s"} to batch
          </Button>
        )}
        {activeTab === "custom" && customMode === "freetext" && (() => {
          const rawLines = customText.split("\n").map((l) => l.trim()).filter(Boolean);
          let totalWrapped = 0;
          let overflow = false;
          for (const line of rawLines) {
            const wrapped = Math.max(1, Math.ceil(line.length / labelCapacity.maxCharsPerLine));
            totalWrapped += wrapped;
            if (line.length > labelCapacity.maxCharsPerLine) overflow = true;
          }
          if (totalWrapped > labelCapacity.maxLines) overflow = true;
          const textOverflows = overflow && customText.trim().length > 0;
          return (
          <Button
            type="button"
            variant="primary"
            onClick={addCustomFreeText}
            disabled={!customText.trim() || textOverflows}
            className="w-full"
          >
            + Add {customCount} custom label{customCount === 1 ? "" : "s"} to batch
          </Button>
          );
        })()}
        {activeTab === "custom" && customMode === "sequence" && (
          <Button
            type="button"
            variant="primary"
            onClick={addCustomSequence}
            disabled={seqCount < 1}
            className="w-full"
          >
            + Add {seqCount} sequence label{seqCount === 1 ? "" : "s"} to batch
          </Button>
        )}



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
                onClick={() => { if (window.confirm("Clear all labels from the batch?")) clearBatch(); }}
                className="rounded border border-border px-2 py-1 text-[10px] text-muted-foreground hover:bg-muted"
              >
                Clear all
              </button>
            )}
          </div>

          <div className="max-h-[320px] overflow-y-auto rounded-md border border-border bg-background">
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
                        {row.label.barcode ? (
                          <>
                            <BarcodeThumb
                              value={row.label.barcode}
                              containerWidth={80}
                              containerHeight={28}
                            />
                            <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                              {row.label.barcode}
                            </div>
                          </>
                        ) : (
                          <div className="font-mono text-[10px] text-muted-foreground">
                            {[row.label.line1, row.label.line2, row.label.line3].filter(Boolean).join(" · ") || "(empty)"}
                          </div>
                        )}
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
          <div className="mt-2.5 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={handleDownload}
              disabled={batch.length === 0 || busy}
              className="rounded-md border border-border bg-muted px-3 py-2 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            >
              Download PDF
            </button>
            <button
              type="button"
              onClick={handlePrint}
              disabled={batch.length === 0 || busy}
              className="rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {hasPrintedBatch ? "Reprint" : "Print"}
            </button>
          </div>
        </div>

        {/* Live TSPL batch preview */}
        {(() => {
          // Each cell preview fits inside the right panel; panel ≈ 580px minus padding
          const panelW    = 560;
          const cellPreviewW = Math.floor(panelW / cols);
          const cellPreviewH = Math.round(cellPreviewW * (rollH / (rollW / cols)));
          const MAX_STRIPS = 8;
          const flatLabels = batch.map((r) => r.label);
          // Group into strips of `cols`
          const strips: (typeof flatLabels)[] = [];
          for (let i = 0; i < flatLabels.length; i += cols) {
            strips.push(flatLabels.slice(i, i + cols));
          }
          const visibleStrips = strips.slice(0, MAX_STRIPS);
          const hiddenCount   = flatLabels.length - visibleStrips.length * cols;

          return (
            <div className="rounded-lg border border-border bg-card/60 p-4">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-foreground">
                  Print preview
                  <span className="ml-1.5 font-normal text-muted-foreground text-xs">
                    — actual TSPL layout, {rollW / cols} × {rollH} mm cell
                  </span>
                </h3>
              </div>

              {batch.length === 0 ? (
                <div style={{ height: cellPreviewH || 160 }}
                  className="flex items-center justify-center rounded-md border border-dashed border-border bg-background">
                  <p className="text-center text-xs text-muted-foreground">Add labels to the batch to preview</p>
                </div>
              ) : (
                <div className="max-h-[480px] overflow-y-auto space-y-1 rounded-md border border-border bg-background p-2">
                  {visibleStrips.map((strip, si) => (
                    <div key={si} className="flex" style={{ gap: 2 }}>
                      {Array.from({ length: cols }, (_, ci) => {
                        const lbl = strip[ci];
                        return lbl ? (
                          <TsplLabelPreview
                            key={ci}
                            label={lbl}
                            rollWidthMm={rollW}
                            heightMm={rollH}
                            labelsPerRow={cols}
                            config={tsplConfig}
                            displayWidth={cellPreviewW}
                          />
                        ) : (
                          <div key={ci} style={{ width: cellPreviewW, height: cellPreviewH }}
                            className="rounded border border-dashed border-border bg-muted/20" />
                        );
                      })}
                    </div>
                  ))}
                  {hiddenCount > 0 && (
                    <p className="py-1 text-center text-[10px] text-muted-foreground">
                      +{hiddenCount} more label{hiddenCount === 1 ? "" : "s"} not shown
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {/* History */}
        <div className="rounded-lg border border-border bg-card/60 p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">Recent prints</h3>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => void loadHistory()}
              disabled={historyLoading || busy}
              shortcut="F5"
              className="!text-[10px] !h-7"
            >
              Refresh
            </Button>
          </div>
          <div className="max-h-[320px] overflow-y-auto rounded-md border border-border bg-background">
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
                        {row.barcode} · qty {row.qty}{row.printer ? ` · ${row.printer}` : ""}{row.labelSize ? ` · ${row.labelSize}` : ""}
                      </p>
                      {(row.line1 || row.line2) && (
                        <p className="font-mono text-[10px] text-muted-foreground truncate max-w-[240px]">
                          {[row.line1, row.line2].filter(Boolean).join(" · ")}
                        </p>
                      )}
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

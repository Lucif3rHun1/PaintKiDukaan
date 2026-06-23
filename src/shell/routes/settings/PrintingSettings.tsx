// @ts-nocheck
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "../../../lib/feedback/toast";
import { Button, Card, Section, Skeleton } from "../../../components/ui";
import { ipc, type DiscoveredPrinter } from "../../lib/ipc";
import { extractError } from "../../../lib/extractError";

// Thermal printing (ESC/POS via Win32) is Windows-only.
// PDF receipts and labels work everywhere. Backend returns empty list on non-Windows.
const isWindows = (): boolean => {
  if (typeof navigator === "undefined" || !navigator.platform) return false;
  return navigator.platform.toLowerCase().includes("win");
};

/* ── shared helpers ─────────────────────────────────────────────── */

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

const inputCls =
  "w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary";

/* ── Printer types & helpers ────────────────────────────────────── */

interface Printer {
  id: string;
  name: string;
  connection_type: "usb" | "bluetooth" | "network" | "serial";
  address: string;
  is_default: boolean;
}

const CONN_TYPES: { value: Printer["connection_type"]; label: string }[] = [
  { value: "usb", label: "USB" },
  { value: "bluetooth", label: "Bluetooth" },
  { value: "network", label: "Network (IP)" },
  { value: "serial", label: "Serial (COM)" },
];

const CONN_HINTS: Record<Printer["connection_type"], string> = {
  usb: "Not required for USB",
  bluetooth: "e.g., Printer-BT-001",
  network: "e.g., 192.168.1.100:9100",
  serial: "e.g., COM3",
};

function toConnectionType(value: string): Printer["connection_type"] {
  const normalized = value.toLowerCase();
  return CONN_TYPES.some((type) => type.value === normalized)
    ? (normalized as Printer["connection_type"])
    : "usb";
}

/* ── PrinterManager (shared inline CRUD) ────────────────────────── */

function PrinterManager({
  printers,
  onChange,
}: {
  printers: Printer[];
  onChange: (next: Printer[]) => void;
}) {
  const [name, setName] = useState("");
  const [connType, setConnType] = useState<Printer["connection_type"]>("usb");
  const [address, setAddress] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredPrinter[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryMessage, setDiscoveryMessage] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  function add() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Printer name is required");
      return;
    }
    const printer: Printer = {
      id: crypto.randomUUID(),
      name: trimmed,
      connection_type: connType,
      address: connType === "usb" ? "" : address.trim(),
      is_default: isDefault,
    };
    const next = isDefault
      ? [...printers.map((p) => ({ ...p, is_default: false })), printer]
      : [...printers, printer];
    onChange(next);
    setName("");
    setConnType("usb");
    setAddress("");
    setIsDefault(false);
    toast.success(`Printer "${trimmed}" added`);
  }

  async function discoverPrinters() {
    setDiscovering(true);
    setDiscoveryMessage(null);
    try {
      const rows = await ipc.discoverSystemPrinters();
      setDiscovered(rows);
      setDiscoveryMessage(
        rows.length === 0
          ? "No printers found. Add one manually below."
          : `Found ${rows.length} printer${rows.length === 1 ? "" : "s"}.`,
      );
      toast.success("Printer discovery complete");
    } catch (e) {
      const message = isWindows()
        ? "Auto-discovery not available on this platform"
        : "Thermal printer discovery is only available on Windows";
      setDiscovered([]);
      setDiscoveryMessage(message);
      toast.error(message, extractError(e));
    } finally {
      setDiscovering(false);
    }
  }

  function addDiscoveredPrinter(discoveredPrinter: DiscoveredPrinter) {
    const trimmed = discoveredPrinter.name.trim();
    if (!trimmed) {
      toast.error("Discovered printer name is missing");
      return;
    }
    if (printers.some((printer) => printer.name === trimmed)) {
      toast.error(`Printer "${trimmed}" is already configured`);
      return;
    }
    const connectionType = toConnectionType(discoveredPrinter.connection_type);
    const printer: Printer = {
      id: crypto.randomUUID(),
      name: trimmed,
      connection_type: connectionType,
      address: connectionType === "usb" ? "" : discoveredPrinter.port_name ?? "",
      is_default: printers.length === 0,
    };
    onChange(printers.length === 0 ? [printer] : [...printers, printer]);
    toast.success(`Printer "${trimmed}" added`);
  }

  function remove(id: string) {
    const p = printers.find((pr) => pr.id === id);
    onChange(printers.filter((pr) => pr.id !== id));
    if (p) toast.success(`Printer "${p.name}" removed`);
  }

  async function testPrint(p: Printer) {
    if (!p.name.trim()) {
      toast.error("Printer name is missing");
      return;
    }
    setTestingId(p.id);
    try {
      await ipc.printEscPosReceipt(p.name, {
        shop_name: "PaintKiDukaan",
        shop_address: "Test print",
        sale_number: "TEST-001",
        created_at: new Date().toLocaleString(),
        customer_name: "Test Customer",
        items: [
          {
            name: "Test Item",
            qty: "1",
            unit: "pc",
            unit_price: "Rs.10.00",
            line_total: "Rs.10.00",
          },
        ],
        subtotal: "Rs.10.00",
        discount: "Rs.0.00",
        total: "Rs.10.00",
        paid: "Rs.10.00",
        due: "Rs.0.00",
        payments: [{ mode: "CASH", amount: "Rs.10.00" }],
      });
      toast.success(`Test page sent to "${p.name}"`);
    } catch (e) {
      toast.error("Test print failed", extractError(e));
    } finally {
      setTestingId(null);
    }
  }

  function toggleDefault(id: string) {
    const wasDefault = printers.find((p) => p.id === id)?.is_default;
    onChange(
      printers.map((p) => ({
        ...p,
        is_default: wasDefault ? false : p.id === id,
      })),
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted/40 p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-foreground">Auto-discover printers</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Scan the system printer list, then add any matching device below.
            </p>
          </div>
          <Button type="button" variant="secondary" onClick={() => void discoverPrinters()} loading={discovering}>
            Auto-discover printers
          </Button>
        </div>
        {discoveryMessage ? (
          <p className="mt-3 rounded border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
            {discoveryMessage}
          </p>
        ) : null}
        {discovered.length > 0 ? (
          <div className="mt-3 space-y-2">
            {discovered.map((printer) => {
              const configured = printers.some((existing) => existing.name === printer.name);
              return (
                <div
                  key={`${printer.name}-${printer.port_name ?? ""}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card/70 px-3 py-2"
                >
                  <div className="min-w-0 text-sm">
                    <p className="truncate font-medium text-foreground">{printer.name}</p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {[printer.connection_type, printer.driver_name, printer.port_name].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => addDiscoveredPrinter(printer)}
                    disabled={configured}
                  >
                    {configured ? "Added" : "Add"}
                  </Button>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      {/* ── add form ─────────────────────────────────────────── */}
      <div className="grid max-w-lg grid-cols-2 gap-3">
        <Field label="Printer name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Counter Thermal"
            className={inputCls}
          />
        </Field>
        <Field label="Connection type">
          <select
            value={connType}
            onChange={(e) =>
              setConnType(e.target.value as Printer["connection_type"])
            }
            className={inputCls}
          >
            {CONN_TYPES.map((ct) => (
              <option key={ct.value} value={ct.value}>
                {ct.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Address">
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={CONN_HINTS[connType]}
            className={inputCls}
            disabled={connType === "usb"}
          />
        </Field>
        <div className="flex items-end gap-3">
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="rounded border-border bg-muted text-primary focus:ring-primary"
            />
            Default
          </label>
          <Button onClick={add}>Add printer</Button>
        </div>
      </div>

      {/* ── printer list ─────────────────────────────────────── */}
      {printers.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No printers configured. Add one above to get started.
        </p>
      ) : (
        <div className="space-y-2">
          {printers.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between rounded-lg border border-border bg-muted/50 px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium text-foreground">{p.name}</span>
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                  {
                    CONN_TYPES.find((ct) => ct.value === p.connection_type)
                      ?.label
                  }
                </span>
                {p.address && (
                  <span className="font-mono text-xs text-muted-foreground">
                    {p.address}
                  </span>
                )}
                {p.is_default && (
                  <span className="rounded bg-primary/20 px-1.5 py-0.5 text-xs text-primary">
                    default
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => toggleDefault(p.id)}
                  className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                  title={p.is_default ? "Remove default" : "Set as default"}
                >
                  {p.is_default ? "★" : "☆"}
                </button>
                <button
                  onClick={() => void testPrint(p)}
                  disabled={testingId === p.id}
                  className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                  title="Test print"
                >
                  {testingId === p.id ? "…" : "Test"}
                </button>
                <button
                  onClick={() => remove(p.id)}
                  className="rounded px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                  title="Delete printer"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── 1. LabelSettings (merged: template + printer + size) ──────── */

interface LabelTemplate {
  label_line1?: string;
  label_line2?: string;
}

const LABEL_SIZES = [
  { value: "50x25", label: "50 × 25 mm" },
  { value: "50x50", label: "50 × 50 mm" },
  { value: "38x25", label: "38 × 25 mm" },
] as const;

export function LabelSettings() {
  const [line1, setLine1] = useState("");
  const [line2, setLine2] = useState("");
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [selectedPrinterId, setSelectedPrinterId] = useState("");
  const [labelSize, setLabelSize] = useState("50x25");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      ipc.getSetting("receipt_template"),
      ipc.getSetting("label_printer_name"),
      ipc.getSetting("label_size"),
      ipc.getSetting("printers"),
    ])
      .then(([raw, printerName, size, printersRaw]) => {
        if (raw) {
          try {
            const tpl: LabelTemplate = JSON.parse(raw);
            setLine1(tpl.label_line1 ?? "");
            setLine2(tpl.label_line2 ?? "");
          } catch {
            /* corrupt JSON — start fresh */
          }
        }
        if (size) setLabelSize(size);
    
        let loaded: Printer[] = [];
        if (printersRaw) {
          try {
            loaded = JSON.parse(printersRaw);
          } catch {
            /* corrupt — start fresh */
          }
        }
        setPrinters(loaded);
    
        if (printerName) {
          const match = loaded.find((p) => p.name === printerName);
          if (match) setSelectedPrinterId(match.id);
        }
      }).catch((err: unknown) => console.error("Silent catch replaced:", err))
      .finally(() => setLoading(false));
  }, []);

  function updatePrinters(next: Printer[]) {
    setPrinters(next);
    if (selectedPrinterId && !next.find((p) => p.id === selectedPrinterId)) {
      setSelectedPrinterId("");
    }
    ipc.setSetting("printers", JSON.stringify(next)).catch((e) => {
      toast.error("Failed to save printers", extractError(e));
    });
  }

  async function save() {
    setSaving(true);
    try {
      let existing: Record<string, unknown> = {};
      const raw = await ipc.getSetting("receipt_template");
      if (raw) {
        try {
          existing = JSON.parse(raw);
        } catch {
          /* overwrite */
        }
      }
      const next = {
        ...existing,
        label_line1: line1,
        label_line2: line2,
      };
      const printer = printers.find((p) => p.id === selectedPrinterId);
      await Promise.all([
        ipc.setSetting("receipt_template", JSON.stringify(next)),
        ipc.setSetting("label_printer_name", printer?.name ?? ""),
        ipc.setSetting("label_size", labelSize),
      ]);
      toast.success("Label settings saved");
    } catch (e) {
      toast.error("Failed to save", extractError(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Skeleton variant="card" className="h-60" />;

  return (
    <Card>
      <Section
        title="Shelf labels"
        description="Template text, printer, and label stock size for barcode shelf labels."
      >
        <div className="grid max-w-md gap-4 text-sm">
          <Field label="Label line 1 (template)">
            <input
              value={line1}
              onChange={(e) => setLine1(e.target.value)}
              placeholder="e.g. {shop_name}"
              className={inputCls}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Used as default line 1 when generating labels. Leave blank to use
              the shop name.
            </p>
          </Field>
          <Field label="Label line 2 (template)">
            <input
              value={line2}
              onChange={(e) => setLine2(e.target.value)}
              placeholder="e.g. {brand} {name}"
              className={inputCls}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Used as default line 2. Supports {"{brand}"}, {"{name}"},{" "}
              {"{unit}"}, {"{barcode}"} placeholders.
            </p>
          </Field>
          <Field label="Printer">
            <select
              value={selectedPrinterId}
              onChange={(e) => setSelectedPrinterId(e.target.value)}
              className={inputCls}
            >
              <option value="">— Select a printer —</option>
              {printers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.is_default ? " (default)" : ""}
                </option>
              ))}
            </select>
            {printers.length === 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                No printers configured. Add one in the printers section below.
              </p>
            )}
          </Field>
          <Field label="Label stock size">
            <select
              value={labelSize}
              onChange={(e) => setLabelSize(e.target.value)}
              className={inputCls}
            >
              {LABEL_SIZES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex justify-end">
            <Button onClick={save} loading={saving}>
              Save
            </Button>
          </div>
        </div>
      </Section>

      <Section
        title="Printers"
        description="Manage printers available for label printing."
      >
        <PrinterManager printers={printers} onChange={updatePrinters} />
        {!isWindows() && (
          <p className="mt-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-400">
            Thermal printing (receipts on 58/80mm rolls) is only available on Windows.
            PDF labels work on all platforms.
          </p>
        )}
      </Section>
    </Card>
  );
}

/* ── 2. ReceiptSettings (merged: template + printer + paper) ───── */

interface ReceiptTemplate {
  receipt_header?: string;
  receipt_footer?: string;
  receipt_terms?: string;
}

const PAPER_SIZES = [
  { value: "thermal-58mm", label: "Thermal 58 mm" },
  { value: "thermal-80mm", label: "Thermal 80 mm" },
  { value: "A4", label: "A4" },
  { value: "A5", label: "A5" },
] as const;

export function ReceiptSettings() {
  const [header, setHeader] = useState("");
  const [footer, setFooter] = useState("");
  const [terms, setTerms] = useState("");
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [selectedPrinterId, setSelectedPrinterId] = useState("");
  const [paperSize, setPaperSize] = useState("thermal-80mm");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      ipc.getSetting("receipt_template"),
      ipc.getSetting("receipt_printer_name"),
      ipc.getSetting("receipt_paper_size"),
      ipc.getSetting("printers"),
    ])
      .then(([raw, printerName, size, printersRaw]) => {
        if (raw) {
          try {
            const tpl: ReceiptTemplate = JSON.parse(raw);
            setHeader(tpl.receipt_header ?? "");
            setFooter(tpl.receipt_footer ?? "");
            setTerms(tpl.receipt_terms ?? "");
          } catch {
            /* corrupt JSON — start fresh */
          }
        }
        if (size) setPaperSize(size);
    
        let loaded: Printer[] = [];
        if (printersRaw) {
          try {
            loaded = JSON.parse(printersRaw);
          } catch {
            /* corrupt — start fresh */
          }
        }
        setPrinters(loaded);
    
        if (printerName) {
          const match = loaded.find((p) => p.name === printerName);
          if (match) setSelectedPrinterId(match.id);
        }
      }).catch((err: unknown) => console.error("Silent catch replaced:", err))
      .finally(() => setLoading(false));
  }, []);

  function updatePrinters(next: Printer[]) {
    setPrinters(next);
    if (selectedPrinterId && !next.find((p) => p.id === selectedPrinterId)) {
      setSelectedPrinterId("");
    }
    ipc.setSetting("printers", JSON.stringify(next)).catch((e) => {
      toast.error("Failed to save printers", extractError(e));
    });
  }

  async function save() {
    setSaving(true);
    try {
      let existing: Record<string, unknown> = {};
      const raw = await ipc.getSetting("receipt_template");
      if (raw) {
        try {
          existing = JSON.parse(raw);
        } catch {
          /* overwrite */
        }
      }
      const next = {
        ...existing,
        receipt_header: header,
        receipt_footer: footer,
        receipt_terms: terms,
      };
      const printer = printers.find((p) => p.id === selectedPrinterId);
      await Promise.all([
        ipc.setSetting("receipt_template", JSON.stringify(next)),
        ipc.setSetting("receipt_printer_name", printer?.name ?? ""),
        ipc.setSetting("receipt_paper_size", paperSize),
      ]);
      toast.success("Receipt settings saved");
    } catch (e) {
      toast.error("Failed to save", extractError(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Skeleton variant="card" className="h-60" />;

  return (
    <Card>
      <Section
        title="Receipts"
        description="Receipt header, footer, terms, printer, and paper size for customer invoices."
      >
        <div className="grid max-w-md gap-4 text-sm">
          <Field label="Header text">
            <input
              value={header}
              onChange={(e) => setHeader(e.target.value)}
              placeholder="Paint Ki Dukaan"
              className={inputCls}
            />
          </Field>
          <Field label="Footer text">
            <input
              value={footer}
              onChange={(e) => setFooter(e.target.value)}
              placeholder="Thank you for your purchase!"
              className={inputCls}
            />
          </Field>
          <Field label="Terms & conditions">
            <textarea
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              rows={3}
              placeholder="No returns without receipt within 7 days."
              className={inputCls}
            />
          </Field>
          <Field label="Printer">
            <select
              value={selectedPrinterId}
              onChange={(e) => setSelectedPrinterId(e.target.value)}
              className={inputCls}
            >
              <option value="">— Select a printer —</option>
              {printers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.is_default ? " (default)" : ""}
                </option>
              ))}
            </select>
            {printers.length === 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                No printers configured. Add one in the printers section below.
              </p>
            )}
          </Field>
          <Field label="Paper size">
            <select
              value={paperSize}
              onChange={(e) => setPaperSize(e.target.value)}
              className={inputCls}
            >
              {PAPER_SIZES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex justify-end">
            <Button onClick={save} loading={saving}>
              Save
            </Button>
          </div>
        </div>
      </Section>

      <Section
        title="Printers"
        description="Manage printers available for receipt printing."
      >
        <PrinterManager printers={printers} onChange={updatePrinters} />
        {!isWindows() && (
          <p className="mt-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-400">
            Thermal printing (receipts on 58/80mm rolls) is only available on Windows.
            PDF receipts work on all platforms.
          </p>
        )}
      </Section>
    </Card>
  );
}

/* ── 3. ScannerSettings (thresholds + interactive test area) ───── */

export function ScannerSettings() {
  const [minLength, setMinLength] = useState("6");
  const [avgMsPerChar, setAvgMsPerChar] = useState("30");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Test area state
  const testInputRef = useRef<HTMLInputElement>(null);
  const [testValue, setTestValue] = useState("");
  const [testHistory, setTestHistory] = useState<
    { barcode: string; ms: number; chars: number }[]
  >([]);
  const bufferRef = useRef<{ chars: string; start: number }>({
    chars: "",
    start: 0,
  });

  useEffect(() => {
    Promise.all([
      ipc.getSetting("scanner_min_length"),
      ipc.getSetting("scanner_avg_ms_per_char"),
    ])
      .then(([ml, ms]) => {
        if (ml) setMinLength(ml);
        if (ms) setAvgMsPerChar(ms);
      }).catch((err: unknown) => console.error("Silent catch replaced:", err))
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    setSaving(true);
    try {
      await Promise.all([
        ipc.setSetting("scanner_min_length", minLength),
        ipc.setSetting("scanner_avg_ms_per_char", avgMsPerChar),
      ]);
      toast.success("Scanner settings saved");
    } catch (e) {
      toast.error("Failed to save", extractError(e));
    } finally {
      setSaving(false);
    }
  }

  const handleTestKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const buf = bufferRef.current;
      const now = performance.now();

      if (e.key === "Enter") {
        // Scanner sends Enter as terminator
        if (buf.chars.length > 0) {
          const totalMs = now - buf.start;
          const ml = Number(minLength) || 6;
          const ms = Number(avgMsPerChar) || 30;
          const isScanner =
            buf.chars.length >= ml &&
            totalMs <= Math.max(150, buf.chars.length * ms);

          setTestHistory((prev) => [
            {
              barcode: buf.chars,
              ms: Math.round(totalMs),
              chars: buf.chars.length,
            },
            ...prev.slice(0, 19),
          ]);
          setTestValue(buf.chars);
        }
        buf.chars = "";
        buf.start = 0;
        e.preventDefault();
        return;
      }

      // Start new buffer or continue existing
      if (buf.chars.length === 0) {
        buf.chars = e.key;
        buf.start = now;
      } else {
        buf.chars += e.key;
      }
    },
    [minLength, avgMsPerChar],
  );

  if (loading) return <Skeleton variant="card" className="h-48" />;

  const ml = Number(minLength) || 6;
  const ms = Number(avgMsPerChar) || 30;

  return (
    <Card>
      <Section
        title="Barcode scanner"
        description="Tune keyboard-wedge detection thresholds and test scanner input."
      >
        <div className="grid max-w-md gap-4 text-sm">
          <Field label="Minimum barcode length">
            <input
              type="number"
              min={2}
              max={20}
              value={minLength}
              onChange={(e) => setMinLength(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Average ms per character">
            <input
              type="number"
              min={5}
              max={100}
              value={avgMsPerChar}
              onChange={(e) => setAvgMsPerChar(e.target.value)}
              className={inputCls}
            />
          </Field>
          <p className="text-xs text-muted-foreground">
            Characters arriving faster than{" "}
            <span className="text-muted-foreground">
              {ml} × {ms} ms = {ml * ms} ms
            </span>{" "}
            are treated as scanner input.
          </p>
          <div className="flex justify-end">
            <Button onClick={save} loading={saving}>
              Save
            </Button>
          </div>
        </div>
      </Section>

      <Section
        title="Test scanner"
        description="Scan a barcode or type quickly into the field below to verify detection."
      >
        <div className="grid max-w-md gap-4 text-sm">
          <Field label="Scan input (focus and scan a barcode)">
            <input
              ref={testInputRef}
              value={testValue}
              onChange={(e) => setTestValue(e.target.value)}
              onKeyDown={handleTestKeyDown}
              placeholder="Click here, then scan a barcode…"
              className={inputCls}
              autoFocus
            />
          </Field>

          {testHistory.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                Recent scans ({testHistory.length})
              </p>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-left text-sm">
                  <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">Barcode</th>
                      <th className="px-3 py-2">Time</th>
                      <th className="px-3 py-2">Chars</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {testHistory.map((entry, i) => (
                      <tr key={i} className="text-foreground">
                        <td className="px-3 py-2 font-mono">{entry.barcode}</td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {entry.ms} ms
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {entry.chars}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </Section>
    </Card>
  );
}

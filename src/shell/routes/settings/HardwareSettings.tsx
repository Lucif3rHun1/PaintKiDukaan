import { useCallback, useEffect, useState } from "react";
import { Barcode, Loader2, Plus, Printer, ScanBarcode, ScanLine, Trash2 } from "lucide-react";
import { Button } from "../../../components/ui/Button";
import { Card } from "../../../components/ui/Card";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Section } from "../../../components/ui/Section";
import { Radio } from "../../../components/ui/Radio";
import { Select } from "../../../components/ui/Select";
import { InlineDialog } from "../../../components/ui/InlineDialog";
import { emit } from "@tauri-apps/api/event";
import { ipc } from "../../lib/ipc";
import { extractError } from "../../../lib/extractError";
import { loadNumber, loadString, saveSetting } from "./components/SettingsFields";
import type {
  DiscoveredPrinter,
  NewPrinterInput,
  PrinterConnectionType,
  PrinterRecord,
  ReceiptPaperSize,
} from "./printing-types";

type Tab = "printers" | "scanner";

const RECEIPT_PAPER_OPTIONS: { value: ReceiptPaperSize; label: string }[] = [
  { value: "a4", label: "A4 (default)" },
  { value: "a5", label: "A5" },
  { value: "thermal-58mm", label: "Thermal 58mm" },
  { value: "thermal-80mm", label: "Thermal 80mm" },
];

const CONNECTION_OPTIONS: { value: PrinterConnectionType; label: string }[] = [
  { value: "usb", label: "USB" },
  { value: "bluetooth", label: "Bluetooth" },
  { value: "network", label: "Network" },
  { value: "serial", label: "Serial" },
  { value: "system", label: "System (driver)" },
];

export function HardwareSettings() {
  const [tab, setTab] = useState<Tab>("printers");
  return (
    <div className="space-y-4">
      <nav className="flex gap-2 border-b border-border" aria-label="Hardware sections">
        <TabButton active={tab === "printers"} onClick={() => setTab("printers")} icon={<Printer className="h-4 w-4" />}>
          Printers
        </TabButton>
        <TabButton active={tab === "scanner"} onClick={() => setTab("scanner")} icon={<ScanBarcode className="h-4 w-4" />}>
          Scanner
        </TabButton>
      </nav>
      {tab === "printers" ? <PrintersPanel /> : <ScannerPanel />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        "flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background " +
        (active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground")
      }
    >
      {icon}
      {children}
    </button>
  );
}

type ModalState =
  | { mode: "add"; prefill?: DiscoveredPrinter }
  | { mode: "edit"; printer: PrinterRecord }
  | null;

function PrintersPanel() {
  const [printers, setPrinters] = useState<PrinterRecord[] | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredPrinter[] | null>(null);
  const [discoverLoaded, setDiscoverLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      setPrinters(await ipc.listPrinters());
    } catch (e) {
      setError(extractError(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function save(input: NewPrinterInput, editingId?: number) {
    setBusy(true);
    setError(null);
    try {
      if (editingId !== undefined) {
        await ipc.updatePrinter(editingId, input);
      } else {
        await ipc.createPrinter(input);
      }
      setModal(null);
      await reload();
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  }

  async function setDefault(id: number) {
    setBusy(true);
    try {
      await ipc.setDefaultPrinter(id);
      await reload();
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    setBusy(true);
    try {
      await ipc.deletePrinter(id);
      await reload();
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  }

  async function discover() {
    setBusy(true);
    setError(null);
    try {
      const list = await ipc.discoverSystemPrinters();
      setDiscovered(list);
      setDiscoverLoaded(true);
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {error ? (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <Section
        title="Saved printers"
        description="Each printer is bound to one use case (receipt or label). Label stock size is set per-item on the barcode label page."
        actions={
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={discover} disabled={busy}>
              <ScanLine className="h-4 w-4" /> Discover
            </Button>
            <Button size="sm" onClick={() => setModal({ mode: "add" })} shortcut="F6">
              <Plus className="h-4 w-4" /> Add printer
            </Button>
          </div>
        }
      >
        {printers === null ? (
          <SkeletonRows />
        ) : printers.length === 0 ? (
          <EmptyState
            icon={<Printer className="h-8 w-8" />}
            title="No printers yet"
            description="Discover devices on this machine or add one manually."
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {printers.map((p) => (
              <PrinterCard
                key={p.id}
                printer={p}
                onSetDefault={() => setDefault(p.id)}
                onEdit={() => setModal({ mode: "edit", printer: p })}
                onRemove={() => remove(p.id)}
              />
            ))}
          </div>
        )}
      </Section>

      {discoverLoaded ? (
        <Section
          title="Discovered printers"
          description={
            discovered && discovered.length > 0
              ? "Pick one to add it as a receipt or label printer."
              : "No devices found. Plug the printer in (USB / power on / share the network printer) and try again."
          }
        >
          {discovered && discovered.length > 0 ? (
            <div className="grid gap-2 md:grid-cols-2">
              {discovered.map((d) => (
                <Card key={`${d.name}-${d.port_name ?? ""}`}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{d.name}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {d.driver_name ?? "—"} · {d.port_name ?? "—"} · {d.connection_type}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => {
                        setModal({ mode: "add", prefill: d });
                        setDiscovered(null);
                        setDiscoverLoaded(false);
                      }}
                    >
                      Add
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          ) : null}
          <div className="flex justify-end pt-2">
            <Button size="sm" variant="ghost" onClick={() => { setDiscovered(null); setDiscoverLoaded(false); }}>
              Dismiss
            </Button>
          </div>
        </Section>
      ) : null}

      {modal ? (
        <PrinterModal
          state={modal}
          saving={busy}
          onCancel={() => setModal(null)}
          onSave={save}
        />
      ) : null}
    </div>
  );
}

function PrinterCard({
  printer,
  onSetDefault,
  onEdit,
  onRemove,
}: {
  printer: PrinterRecord;
  onSetDefault: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <Card>
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate font-semibold">{printer.name}</div>
            <div className="text-xs text-muted-foreground">
              {printer.use_case === "label"
                ? `Label · ${printer.connection_type}`
                : `Receipt · ${printer.paper_size ?? "a4"} · ${printer.connection_type}`}
            </div>
          </div>
          {printer.is_default ? (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">Default</span>
          ) : null}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={onEdit}>
            Edit
          </Button>
          {!printer.is_default ? (
            <Button size="sm" variant="ghost" onClick={onSetDefault}>
              Set default
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={onRemove}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </Card>
  );
}

function PrinterModal({
  state,
  saving,
  onCancel,
  onSave,
}: {
  state: NonNullable<ModalState>;
  saving: boolean;
  onCancel: () => void;
  onSave: (input: NewPrinterInput, editingId?: number) => void;
}) {
  const initial: NewPrinterInput =
    state.mode === "edit"
      ? {
          name: state.printer.name,
          use_case: state.printer.use_case,
          connection_type: state.printer.connection_type,
          address: state.printer.address,
          driver_name: state.printer.driver_name,
          port_name: state.printer.port_name,
          is_default: state.printer.is_default,
          label_width_mm: state.printer.label_width_mm,
          label_height_mm: state.printer.label_height_mm,
          paper_size: state.printer.paper_size,
        }
      : state.prefill
        ? {
            name: state.prefill.name,
            use_case: "receipt",
            connection_type: asConnectionType(state.prefill.connection_type),
            address: state.prefill.port_name ?? "",
            driver_name: state.prefill.driver_name,
            port_name: state.prefill.port_name,
            is_default: false,
            label_width_mm: null,
            label_height_mm: null,
            paper_size: "a4",
          }
        : blankPrinter();

  const [input, setInput] = useState<NewPrinterInput>(initial);
  const editingId = state.mode === "edit" ? state.printer.id : undefined;

  function update<K extends keyof NewPrinterInput>(key: K, value: NewPrinterInput[K]) {
    setInput((prev) => ({ ...prev, [key]: value }));
  }

  function changeUseCase(useCase: "receipt" | "label") {
    setInput((prev) => ({
      ...prev,
      use_case: useCase,
      label_width_mm: null,
      label_height_mm: null,
      paper_size: useCase === "receipt" ? prev.paper_size ?? "a4" : null,
    }));
  }

  const title = state.mode === "edit" ? `Edit ${state.printer.name}` : "Add printer";

  return (
    <InlineDialog open onClose={onCancel} title={title} size="md">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Name">
          <input
            className="input"
            value={input.name}
            onChange={(e) => update("name", e.target.value)}
            placeholder="e.g. Xprinter XP-80"
            autoFocus
          />
        </Field>
        <Field label="Use case">
          <div className="flex gap-4 pt-2">
            {(["receipt", "label"] as const).map((u) => (
              <Radio
                key={u}
                name="usecase"
                checked={input.use_case === u}
                onChange={() => changeUseCase(u)}
                label={u === "receipt" ? "Receipt" : "Label"}
              />
            ))}
          </div>
        </Field>
        <Field label="Connection">
          <Select
            value={input.connection_type}
            onChange={(e) => update("connection_type", e.target.value as PrinterConnectionType)}
            options={CONNECTION_OPTIONS}
            size="md"
          />
        </Field>
        <Field label="Address / port">
          <input
            className="input"
            value={input.address}
            onChange={(e) => update("address", e.target.value)}
            placeholder="USB001 or 192.168.1.50"
          />
        </Field>
        {input.use_case === "label" ? (
          <Field label="Label stock">
            <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              Label width and height are set per-item on the barcode label page, not here.
            </div>
          </Field>
        ) : (
          <Field label="Paper size">
            <Select
              value={input.paper_size ?? "a4"}
              onChange={(e) => update("paper_size", e.target.value as ReceiptPaperSize)}
              options={RECEIPT_PAPER_OPTIONS}
              size="md"
            />
          </Field>
        )}
        <label className="col-span-full flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={input.is_default}
            onChange={(e) => update("is_default", e.target.checked)}
          />
          Set as default for this use case
        </label>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={() => onSave(input, editingId)} disabled={saving || !input.name.trim()}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {state.mode === "edit" ? "Save changes" : "Add printer"}
        </Button>
      </div>
    </InlineDialog>
  );
}

function ScannerPanel() {
  const [minLength, setMinLength] = useState<number>(4);
  const [avgMs, setAvgMs] = useState<number>(25);
  const [terminator, setTerminator] = useState<string>("enter");
  const [timeoutMs, setTimeoutMs] = useState<number>(200);
  const [maxSdMs, setMaxSdMs] = useState<number>(8);
  const [loaded, setLoaded] = useState(false);
  const [testInput, setTestInput] = useState("");
  const [lastFired, setLastFired] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [min, avg, term, tms, sd] = await Promise.all([
          loadNumber(ipc.getSetting, "scanner_min_length", 4),
          loadNumber(ipc.getSetting, "scanner_avg_ms_per_char", 25),
          loadString(ipc.getSetting, "scanner_terminator", "enter"),
          loadNumber(ipc.getSetting, "scanner_timeout_ms", 200),
          loadNumber(ipc.getSetting, "scanner_max_sd_ms", 8),
        ]);
        if (cancelled) return;
        setMinLength(min);
        setAvgMs(avg);
        setTerminator(term);
        setTimeoutMs(tms);
        setMaxSdMs(sd);
        setLoaded(true);
      } catch (e) {
        setError(extractError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await saveSetting(ipc.setSetting, "scanner_min_length", minLength);
      await saveSetting(ipc.setSetting, "scanner_avg_ms_per_char", avgMs);
      await saveSetting(ipc.setSetting, "scanner_terminator", terminator);
      await saveSetting(ipc.setSetting, "scanner_timeout_ms", timeoutMs);
      await saveSetting(ipc.setSetting, "scanner_max_sd_ms", maxSdMs);
    } catch (e) {
      setError(extractError(e));
    } finally {
      setSaving(false);
    }
  }

  async function fireScan() {
    const trimmed = testInput.trim();
    if (trimmed.length === 0) return;
    setTestInput("");
    setLastFired(trimmed);
    try {
      await emit("barcode:scan", { barcode: trimmed, ts: Date.now(), terminator: "manual" });
    } catch (e) {
      setError(extractError(e));
    }
  }

  return (
    <div className="space-y-4">
      {error ? (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      <Section title="Scanner behaviour" description="Fine-tune how the scanner reads barcode input.">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Min length (chars)">
            <input
              className="input"
              type="number"
              min={1}
              value={minLength}
              onChange={(e) => setMinLength(Number(e.target.value))}
            />
          </Field>
          <Field label="Avg ms per char">
            <input
              className="input"
              type="number"
              min={1}
              value={avgMs}
              onChange={(e) => setAvgMs(Number(e.target.value))}
            />
          </Field>
          <Field label="Terminator mode">
            <Select
              value={terminator}
              onChange={(e) => setTerminator(e.target.value)}
              options={[
                { value: "enter", label: "Enter" },
                { value: "tab", label: "Tab" },
                { value: "enter+tab", label: "Enter + Tab" },
                { value: "timeout", label: "Timeout (time-gap)" },
              ]}
              size="md"
            />
          </Field>
          <details className="col-span-full rounded-lg border border-border bg-muted/20 px-3 py-2">
            <summary className="cursor-pointer select-none text-sm font-medium text-foreground">Advanced scanner settings</summary>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <Field label="Timeout ms (time-gap mode)">
                <input
                  className="input"
                  type="number"
                  min={50}
                  value={timeoutMs}
                  onChange={(e) => setTimeoutMs(Number(e.target.value))}
                />
              </Field>
              <Field label="Max inter-key SD (ms)">
                <input
                  className="input"
                  type="number"
                  min={1}
                  step={0.5}
                  value={maxSdMs}
                  onChange={(e) => setMaxSdMs(Number(e.target.value))}
                />
              </Field>
            </div>
          </details>
        </div>
        <div className="flex justify-end">
          <Button onClick={save} disabled={!loaded || saving} shortcut="F9">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save
          </Button>
        </div>
      </Section>

      <Section
        title="Manual test"
        description="Type a barcode and press Fire scan to run the full ItemSearchInput to lookupItem to handlePick flow."
      >
        <div className="flex gap-2">
          <input
            className="input flex-1"
            placeholder="e.g. 8901234567894"
            value={testInput}
            onChange={(e) => setTestInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void fireScan();
              }
            }}
          />
          <Button onClick={fireScan} disabled={testInput.trim().length === 0} shortcut="F6">
            <Barcode className="h-4 w-4" /> Fire scan
          </Button>
        </div>
        {lastFired ? (
          <p className="text-xs text-muted-foreground">Last fired: {lastFired}</p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          On macOS the rdev hook is disabled (security exception TSM); use this trigger during dev.
        </p>
      </Section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="space-y-1 text-sm">
      <span className="font-medium text-foreground">{label}</span>
      {children}
    </label>
  );
}

function SkeletonRows() {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {[0, 1].map((i) => (
        <div key={i} className="h-24 animate-pulse motion-reduce:animate-none rounded-lg border border-border bg-card/40" />
      ))}
    </div>
  );
}

function blankPrinter(): NewPrinterInput {
  return {
    name: "",
    use_case: "receipt",
    connection_type: "usb",
    address: "",
    driver_name: null,
    port_name: null,
    is_default: false,
    label_width_mm: null,
    label_height_mm: null,
    paper_size: "a4",
  };
}

function asConnectionType(s: string): PrinterConnectionType {
  if (s === "usb" || s === "bluetooth" || s === "network" || s === "serial" || s === "system") {
    return s;
  }
  return "system";
}

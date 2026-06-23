import { useCallback, useEffect, useState } from "react";
import { Barcode, Loader2, Plus, ScanBarcode, ScanLine, Trash2 } from "lucide-react";
import { Button } from "../../../components/ui/Button";
import { Card } from "../../../components/ui/Card";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Section } from "../../../components/ui/Section";
import { emit } from "@tauri-apps/api/event";
import { ipc } from "../../lib/ipc";
import { extractError } from "../../../lib/extractError";
import type {
  DiscoveredPrinter,
  NewPrinterInput,
  PrinterRecord,
  PrinterConnectionType,
} from "./printing-types";

type Tab = "printers" | "scanner";

export function HardwareSettings() {
  const [tab, setTab] = useState<Tab>("printers");
  return (
    <div className="space-y-4">
      <nav className="flex gap-2 border-b border-border" aria-label="Hardware sections">
        <TabButton active={tab === "printers"} onClick={() => setTab("printers")} icon={<ScanLine className="h-4 w-4" />}>
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

function PrintersPanel() {
  const [printers, setPrinters] = useState<PrinterRecord[] | null>(null);
  const [editing, setEditing] = useState<NewPrinterInput | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredPrinter[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function save(input: NewPrinterInput) {
    setBusy(true);
    setError(null);
    try {
      if (editing && "id" in editing && typeof (editing as { id?: number }).id === "number") {
        await ipc.updatePrinter((editing as unknown as { id: number }).id, input);
      } else {
        await ipc.createPrinter(input);
      }
      setEditing(null);
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
        title="Printers"
        description="Discover connected hardware or add a printer manually. Each printer is bound to a single use case (receipt or label)."
        actions={
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={discover} disabled={busy}>
              <ScanLine className="h-4 w-4" /> Discover
            </Button>
            <Button size="sm" onClick={() => setEditing(blankPrinter())}>
              <Plus className="h-4 w-4" /> Add printer
            </Button>
          </div>
        }
      >
        {printers === null ? (
          <SkeletonRows />
        ) : printers.length === 0 ? (
          <EmptyState
            icon={<ScanLine className="h-8 w-8" />}
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
                onEdit={() =>
                  setEditing({
                    name: p.name,
                    use_case: p.use_case,
                    connection_type: p.connection_type,
                    address: p.address,
                    driver_name: p.driver_name,
                    port_name: p.port_name,
                    is_default: p.is_default,
                    label_width_mm: p.label_width_mm,
                    label_height_mm: p.label_height_mm,
                    paper_size: p.paper_size,
                  })
                }
                onRemove={() => remove(p.id)}
              />
            ))}
          </div>
        )}
      </Section>

      {discovered.length > 0 ? (
        <Section title="Discovered printers" description="Pick one to add as a receipt or label printer.">
          <div className="grid gap-2 md:grid-cols-2">
            {discovered.map((d) => (
              <Card key={d.name}>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{d.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {d.driver_name ?? "—"} · {d.port_name ?? "—"}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => {
                      setEditing({ ...blankPrinter(), name: d.name, driver_name: d.driver_name, port_name: d.port_name });
                      setDiscovered([]);
                    }}
                  >
                    Add
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </Section>
      ) : null}

      {editing ? (
        <PrinterForm
          initial={editing}
          saving={busy}
          onCancel={() => setEditing(null)}
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
                ? `Label · ${printer.label_width_mm ?? "?"}×${printer.label_height_mm ?? "?"}mm`
                : `Receipt · ${printer.paper_size ?? "?"}`}
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

function PrinterForm({
  initial,
  saving,
  onCancel,
  onSave,
}: {
  initial: NewPrinterInput;
  saving: boolean;
  onCancel: () => void;
  onSave: (input: NewPrinterInput) => void;
}) {
  const [input, setInput] = useState<NewPrinterInput>(initial);

  function update<K extends keyof NewPrinterInput>(key: K, value: NewPrinterInput[K]) {
    setInput((prev) => ({ ...prev, [key]: value }));
  }

  function changeUseCase(useCase: "receipt" | "label") {
    setInput((prev) => ({
      ...prev,
      use_case: useCase,
      label_width_mm: useCase === "label" ? prev.label_width_mm ?? 50 : null,
      label_height_mm: useCase === "label" ? prev.label_height_mm ?? 25 : null,
      paper_size: useCase === "receipt" ? prev.paper_size ?? "thermal-80mm" : null,
    }));
  }

  return (
    <Section title="Printer" description="Bind this printer to one use case and stock size.">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Name">
          <input
            className="input"
            value={input.name}
            onChange={(e) => update("name", e.target.value)}
            placeholder="e.g. Xprinter XP-80"
          />
        </Field>
        <Field label="Use case">
          <div className="flex gap-3 pt-2">
            {(["receipt", "label"] as const).map((u) => (
              <label key={u} className="flex items-center gap-2 text-sm">
                <input type="radio" name="usecase" checked={input.use_case === u} onChange={() => changeUseCase(u)} />
                {u === "receipt" ? "Receipt" : "Label"}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Connection">
          <select
            className="input"
            value={input.connection_type}
            onChange={(e) => update("connection_type", e.target.value as PrinterConnectionType)}
          >
            <option value="usb">USB</option>
            <option value="bluetooth">Bluetooth</option>
            <option value="network">Network</option>
            <option value="serial">Serial</option>
            <option value="system">System</option>
          </select>
        </Field>
        <Field label="Address / port">
          <input
            className="input"
            value={input.address}
            onChange={(e) => update("address", e.target.value)}
            placeholder="USB001 or 192.168.1.50"
          />
        </Field>
        <Field label="Driver name (read-only)">
          <input className="input" value={input.driver_name ?? ""} readOnly />
        </Field>
        <Field label="Port name (read-only)">
          <input className="input" value={input.port_name ?? ""} readOnly />
        </Field>
        {input.use_case === "label" ? (
          <>
            <Field label="Label width (mm)">
              <input
                className="input"
                type="number"
                min={1}
                value={input.label_width_mm ?? 0}
                onChange={(e) => update("label_width_mm", Number(e.target.value))}
              />
            </Field>
            <Field label="Label height (mm)">
              <input
                className="input"
                type="number"
                min={1}
                value={input.label_height_mm ?? 0}
                onChange={(e) => update("label_height_mm", Number(e.target.value))}
              />
            </Field>
          </>
        ) : (
          <Field label="Paper size">
            <select
              className="input"
              value={input.paper_size ?? "thermal-80mm"}
              onChange={(e) => update("paper_size", e.target.value as NewPrinterInput["paper_size"])}
            >
              <option value="thermal-58mm">Thermal 58mm</option>
              <option value="thermal-80mm">Thermal 80mm</option>
              <option value="A4">A4</option>
              <option value="A5">A5</option>
            </select>
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
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={() => onSave(input)} disabled={saving || !input.name.trim()}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Save
        </Button>
      </div>
    </Section>
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
        const min = await ipc.getSetting("scanner_min_length");
        const avg = await ipc.getSetting("scanner_avg_ms_per_char");
        const term = await ipc.getSetting("scanner_terminator");
        const tms = await ipc.getSetting("scanner_timeout_ms");
        const sd = await ipc.getSetting("scanner_max_sd_ms");
        if (cancelled) return;
        if (typeof min === "number") setMinLength(min);
        if (typeof avg === "number") setAvgMs(avg);
        if (typeof term === "string") setTerminator(term);
        if (typeof tms === "number") setTimeoutMs(tms);
        if (typeof sd === "number") setMaxSdMs(sd);
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
      await ipc.setSetting("scanner_min_length", minLength);
      await ipc.setSetting("scanner_avg_ms_per_char", avgMs);
      await ipc.setSetting("scanner_terminator", terminator);
      await ipc.setSetting("scanner_timeout_ms", timeoutMs);
      await ipc.setSetting("scanner_max_sd_ms", maxSdMs);
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
      <Section
        title="Scanner behaviour"
        description="Tune how the rdev keyboard-wedge hook converts keystrokes into a barcode event."
      >
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
            <select
              className="input"
              value={terminator}
              onChange={(e) => setTerminator(e.target.value)}
            >
              <option value="enter">Enter</option>
              <option value="tab">Tab</option>
              <option value="enter+tab">Enter + Tab</option>
              <option value="timeout">Timeout (time-gap)</option>
            </select>
          </Field>
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
        <div className="flex justify-end">
          <Button onClick={save} disabled={!loaded || saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save
          </Button>
        </div>
      </Section>

      <Section
        title="Manual test"
        description="Type a barcode and press Fire scan to run the full ItemSearchInput → lookupItem → handlePick flow."
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
          <Button onClick={fireScan} disabled={testInput.trim().length === 0}>
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
    paper_size: "thermal-80mm",
  };
}

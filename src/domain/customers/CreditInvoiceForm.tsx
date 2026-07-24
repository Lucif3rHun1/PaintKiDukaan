import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import {
  Alert,
  Button,
  Card,
  Money,
  MoneyInput,
  DatePicker,
  Select,
} from "../../components/ui";
import { createCustomerCreditInvoice } from "./api";
import { listBrands, listItems } from "../items/api";
import { formatItemName } from "../items/display";
import { toast } from "../../lib/feedback/toast";
import { extractError } from "../../lib/extractError";
import type {
  Brand,
  Customer,
  CreditInvoiceLine,
  Item,
} from "../types";

interface LocalLine {
  item_id: number;
  qty: number;
  unit_price_paise: number;
}

interface CustomerCreditInvoiceFormProps {
  customer: Customer;
  onSaved: () => void;
  onCancel: () => void;
}

export function CustomerCreditInvoiceForm({ customer, onSaved, onCancel }: CustomerCreditInvoiceFormProps) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState("");
  const [lines, setLines] = useState<LocalLine[]>([{ item_id: 0, qty: 1, unit_price_paise: 0 }]);
  const [items, setItems] = useState<Item[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listItems({ limit: 500 })
      .then((d) => setItems(d ?? []))
      .catch((e) => {
        console.error("[CreditInvoiceForm] failed to load items", e);
        setItems([]);
      });
    listBrands()
      .then((d) => setBrands(d ?? []))
      .catch(() => setBrands([]));
  }, []);

  const total = useMemo(
    () => lines.reduce((sum, l) => sum + Math.round(l.qty * l.unit_price_paise), 0),
    [lines],
  );

  function updateLine(index: number, patch: Partial<LocalLine>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function removeLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  function addLine() {
    setLines((prev) => [...prev, { item_id: 0, qty: 1, unit_price_paise: 0 }]);
  }

  async function submit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const validLines: CreditInvoiceLine[] = lines
      .filter((l) => l.item_id > 0 && l.qty > 0 && l.unit_price_paise >= 0)
      .map((l) => ({ item_id: l.item_id, qty: l.qty, unit_price_paise: l.unit_price_paise }));

    if (validLines.length === 0) {
      setError("Add at least one valid item line.");
      return;
    }

    setBusy(true);
    try {
      await toast.promise(
        createCustomerCreditInvoice({
          customer_id: customer.id,
          date,
          description: description.trim() || null,
          lines: validLines,
        }),
        {
          loading: "Creating credit invoice…",
          success: () => "Credit invoice created",
          error: (err: unknown) => extractError(err),
        },
      );
      onSaved();
    } catch (err) {
      setError(extractError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-4 pr-12">
        <h2 className="text-xl font-semibold text-foreground">Add credit invoice</h2>
        <p className="text-sm text-muted-foreground">{customer.name}</p>
      </div>
      <form onSubmit={submit} className="max-h-[60vh] overflow-y-auto pr-1">
        <Card depth="flat" className="space-y-4 p-4">
          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-foreground">Date *</span>
              <DatePicker value={date} onChange={setDate} />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-foreground">Description</span>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. Shade matching charges"
                className="input focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              />
            </label>
          </div>

          <div>
            <h3 className="mb-2 text-sm font-medium text-foreground">Items *</h3>
            <div className="space-y-2">
              {lines.map((line, idx) => (
                <div key={idx} className="grid grid-cols-12 items-end gap-2">
                  <div className="col-span-5">
                    <Select
                      value={String(line.item_id)}
                      onChange={(e) => updateLine(idx, { item_id: Number(e.target.value) })}
                      required
                      options={[
                        { value: "0", label: "Select item…" },
                        ...items.map((item) => ({
                          value: String(item.id),
                          label: `${formatItemName(item, brands)} (${item.unit_code})`,
                        })),
                      ]}
                      size="md"
                    />
                  </div>
                  <div className="col-span-2">
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={line.qty}
                      onChange={(e) => updateLine(idx, { qty: Number(e.target.value) })}
                      required
                      className="input focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      placeholder="Qty"
                    />
                  </div>
                  <div className="col-span-4">
                    <MoneyInput
                      value={line.unit_price_paise}
                      onChange={(v) => updateLine(idx, { unit_price_paise: v })}
                      min={0}
                      required
                    />
                  </div>
                  <div className="col-span-1">
                    {lines.length > 1 && (
                      <Button
                        type="button"
                        onClick={() => removeLine(idx)}
                        variant="destructive"
                        size="icon"
                        className="w-full"
                        aria-label={`Remove line ${idx + 1}`}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={addLine}
          >
            + Add item
          </Button>

          <div className="flex justify-end text-sm font-medium text-foreground">
            Total: <Money paise={total} className="ml-1" />
          </div>

          {error && <Alert variant="destructive">{error}</Alert>}

          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button
              type="button"
              variant="secondary"
              onClick={onCancel}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={busy}>
              {busy ? "Saving…" : "Create credit invoice"}
            </Button>
          </div>
        </Card>
      </form>
    </div>
  );
}

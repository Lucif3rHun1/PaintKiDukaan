import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import {
  Button,
  DataTable,
  InlineDialog,
  Money,
  MoneyInput,
  DatePicker,
  Select,
} from "../../components/ui";
import type { ColumnDef } from "../../components/ui";
import { formatDateForDisplay } from "../../lib/date";
import { fetchCustomerLedger, createCustomerCreditInvoice } from "./api";
import { listItems } from "../items/api";
import { toast } from "../../lib/feedback/toast";
import { extractError } from "../../lib/extractError";
import type {
  AppError,
  Customer,
  CustomerLedger,
  CustomerLedgerTransaction,
  CreditInvoiceLine,
  Item,
} from "../types";

interface Props {
  customer: Customer;
}

export function CustomerLedgerView({ customer }: Props) {
  const [ledger, setLedger] = useState<CustomerLedger | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  function load() {
    setError(null);
    fetchCustomerLedger(customer.id, 200)
      .then((d) => setLedger(d ?? null))
      .catch((e) => setError(extractError(e)));
  }

  useEffect(() => {
    load();
  }, [customer.id]);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Ledger</h3>
        <button
          type="button"
          onClick={() => setShowForm(true)}
          className="btn-primary text-xs"
        >
          + Credit invoice
        </button>
      </div>

      {error && (
        <p className="mb-3 rounded bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      )}

      {!ledger ? (
        <p className="text-sm text-muted-foreground">Loading ledger…</p>
      ) : (
        <>
          <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Opening <Money paise={ledger.opening_balance_paise} />
            </span>
            <span>
              Closing <Money paise={ledger.closing_balance_paise} />
            </span>
          </div>
          <LedgerTable rows={ledger.rows} />
        </>
      )}

      {showForm && (
        <CreditInvoiceModal
          customer={customer}
          onSaved={() => {
            setShowForm(false);
            load();
          }}
          onCancel={() => setShowForm(false)}
        />
      )}
    </div>
  );
}

const columns: ColumnDef<CustomerLedgerTransaction>[] = [
  {
    header: "Date",
    cell: (row) => (
      <span className="font-mono text-xs text-muted-foreground">
        {formatDateForDisplay(row.date)}
      </span>
    ),
  },
  {
    header: "Type",
    cell: (row) => (
      <span
        className={`rounded px-1.5 py-0.5 text-xs ${
          row.kind === "sale"
            ? "bg-warning/20 text-warning"
            : "bg-success/20 text-success"
        }`}
      >
        {row.kind === "sale" ? "Sale" : "Payment"}
      </span>
    ),
  },
  {
    header: "Ref",
    cell: (row) => (
      <span className="text-xs text-muted-foreground">
        {row.ref_no ?? "—"}
      </span>
    ),
  },
  {
    header: "Description",
    cell: (row) => (
      <span className="text-xs text-muted-foreground">
        {row.description ?? "—"}
      </span>
    ),
  },
  {
    header: "Debit",
    align: "right",
    cell: (row) =>
      row.debit_paise > 0 ? <Money paise={row.debit_paise} /> : "—",
  },
  {
    header: "Credit",
    align: "right",
    cell: (row) =>
      row.credit_paise > 0 ? <Money paise={row.credit_paise} /> : "—",
  },
  {
    header: "Balance",
    align: "right",
    cell: (row) => <Money paise={row.balance_paise} />,
  },
];

function LedgerTable({ rows }: { rows: CustomerLedgerTransaction[] }) {
  return (
    <DataTable
      data={rows}
      columns={columns}
      keyExtractor={(_, idx) => idx}
      emptyState={
        <p className="px-3 py-3 text-center text-muted-foreground">
          No activity yet.
        </p>
      }
    />
  );
}

interface CreditInvoiceModalProps {
  customer: Customer;
  onSaved: () => void;
  onCancel: () => void;
}

function CreditInvoiceModal({ customer, onSaved, onCancel }: CreditInvoiceModalProps) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState("");
  const [lines, setLines] = useState<LocalLine[]>([{ item_id: 0, qty: 1, unit_price_paise: 0 }]);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listItems({ limit: 500 })
      .then((d) => setItems(d ?? []))
      .catch((e) => {
        console.error("[CustomerLedgerView] failed to load items", e);
        setItems([]);
      });
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
    <InlineDialog
      open
      onClose={onCancel}
      title="Add credit invoice"
      description={customer.name}
      size="lg"
    >
      <form onSubmit={submit} className="max-h-[60vh] overflow-y-auto pr-1">
        <div className="space-y-4">
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
                className="input"
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
                          label: `${item.name} (${item.unit_code})`,
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
                      className="input"
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
                      <button
                        type="button"
                        onClick={() => removeLine(idx)}
                        className="inline-flex h-10 w-full items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        aria-label={`Remove line ${idx + 1}`}
                      >
                        <X className="h-4 w-4" />
                      </button>
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

          {error && <p className="rounded bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

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
        </div>
      </form>
    </InlineDialog>
  );
}

interface LocalLine {
  item_id: number;
  qty: number;
  unit_price_paise: number;
}

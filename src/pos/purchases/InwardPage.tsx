// Inward (purchase) page — sticky cost, box/unit conversion, optional vendor,
// auto-print label toggle (E-IA1).

import { useEffect, useMemo, useState } from "react";
import { createInward, lastCost, listPurchases } from "../api";
import type { InwardLine, NewPurchase, Purchase } from "../types";

interface Props {
  user: { id: number; name: string; role: "owner" | "cashier" | "stocker" };
}

interface DraftLine {
  item_id: number;
  qty: number;
  unit_type: "unit" | "box";
  cost_price: number;
  retail_price: number;
  location_id: number;
}

const DEMO_ITEM_ID = 1;

export default function InwardPage({ user }: Props) {
  const [draft, setDraft] = useState<DraftLine[]>([]);
  const [vendorId, setVendorId] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [autoPrint, setAutoPrint] = useState(true);
  const [recent, setRecent] = useState<Purchase[]>([]);
  const [status, setStatus] = useState<string | null>(null);

  const total = useMemo(
    () =>
      draft.reduce(
        (s, l) =>
          s +
          (l.unit_type === "box" ? l.qty * 4 : l.qty) * l.cost_price,
        0
      ),
    [draft]
  );

  useEffect(() => {
    listPurchases().then(setRecent).catch(() => {});
  }, []);

  async function addLine() {
    // Sticky cost: fetch last cost for item, default retail 10000.
    let cost = 5000;
    try {
      const c = await lastCost(DEMO_ITEM_ID);
      if (c != null) cost = c;
    } catch {}
    setDraft((p) => [
      ...p,
      {
        item_id: DEMO_ITEM_ID,
        qty: 1,
        unit_type: "unit",
        cost_price: cost,
        retail_price: 10000,
        location_id: 1,
      },
    ]);
  }

  async function submit() {
    const req: NewPurchase = {
      vendor_id: vendorId,
      notes: notes || null,
      auto_print_label: autoPrint,
      lines: draft as InwardLine[],
    };
    try {
      const res = await createInward(req);
      setStatus(`Inward #${res.id} saved${res.print_label ? " — label will print" : ""}`);
      setDraft([]);
      setNotes("");
      setRecent(await listPurchases());
    } catch (e) {
      setStatus(`Error: ${String(e)}`);
    }
  }

  return (
    <div className="grid grid-cols-3 gap-4">
      <section className="col-span-2 rounded border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-600">Inward lines</h2>
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th>Item</th>
              <th>Qty</th>
              <th>Unit</th>
              <th>Cost</th>
              <th>Retail</th>
              <th>Loc</th>
              <th>Base qty</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {draft.map((l, i) => (
              <tr key={i} className="border-t border-slate-100">
                <td>#{l.item_id}</td>
                <td>
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    value={l.qty}
                    onChange={(e) =>
                      setDraft((p) => p.map((x, j) => (j === i ? { ...x, qty: Number(e.target.value) } : x)))
                    }
                    className="w-16 rounded border border-slate-300 px-1"
                  />
                </td>
                <td>
                  <select
                    value={l.unit_type}
                    onChange={(e) =>
                      setDraft((p) =>
                        p.map((x, j) =>
                          j === i ? { ...x, unit_type: e.target.value as "unit" | "box" } : x
                        )
                      )
                    }
                    className="rounded border border-slate-300 px-1"
                  >
                    <option value="unit">unit</option>
                    <option value="box">box</option>
                  </select>
                </td>
                <td>
                  <input
                    type="number"
                    min="0"
                    value={l.cost_price}
                    onChange={(e) =>
                      setDraft((p) =>
                        p.map((x, j) => (j === i ? { ...x, cost_price: Number(e.target.value) } : x))
                      )
                    }
                    className="w-24 rounded border border-slate-300 px-1"
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min="0"
                    value={l.retail_price}
                    onChange={(e) =>
                      setDraft((p) =>
                        p.map((x, j) => (j === i ? { ...x, retail_price: Number(e.target.value) } : x))
                      )
                    }
                    className="w-24 rounded border border-slate-300 px-1"
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min="1"
                    value={l.location_id}
                    onChange={(e) =>
                      setDraft((p) =>
                        p.map((x, j) => (j === i ? { ...x, location_id: Number(e.target.value) } : x))
                      )
                    }
                    className="w-16 rounded border border-slate-300 px-1"
                  />
                </td>
                <td>{l.unit_type === "box" ? l.qty * 4 : l.qty}</td>
                <td>
                  <button
                    onClick={() => setDraft((p) => p.filter((_, j) => j !== i))}
                    className="text-red-600 hover:underline"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button
          onClick={addLine}
          className="mt-2 rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50"
          data-testid="inward-add-line"
        >
          + Add line (sticky cost)
        </button>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <label className="text-sm">
            Vendor ID (optional)
            <input
              type="number"
              value={vendorId ?? ""}
              onChange={(e) => setVendorId(e.target.value ? Number(e.target.value) : null)}
              className="ml-2 w-24 rounded border border-slate-300 px-1"
            />
          </label>
          <label className="text-sm">
            <input
              type="checkbox"
              checked={autoPrint}
              onChange={(e) => setAutoPrint(e.target.checked)}
              className="mr-1"
              data-testid="auto-print-label"
            />
            Auto-print shelf label after save
          </label>
          <label className="col-span-2 text-sm">
            Notes
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="ml-2 w-2/3 rounded border border-slate-300 px-1"
            />
          </label>
        </div>
      </section>
      <aside className="rounded border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-600">Totals</h2>
        <p className="mt-2 text-2xl font-semibold" data-testid="inward-total">
          ₹{total / 100}
        </p>
        <button
          onClick={submit}
          disabled={draft.length === 0}
          className="mt-4 w-full rounded bg-sky-600 py-2 font-semibold text-white disabled:opacity-50"
          data-testid="inward-submit"
        >
          Save inward
        </button>
        {status && <p className="mt-2 text-xs text-slate-600">{status}</p>}
      </aside>
      <section className="col-span-3 rounded border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-600">Recent inwards</h2>
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th>#</th>
              <th>Date</th>
              <th>Lines</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((p) => (
              <tr key={p.id} className="border-t border-slate-100">
                <td>{p.id}</td>
                <td>{p.date}</td>
                <td>{p.items.length}</td>
                <td>₹{p.total / 100}</td>
              </tr>
            ))}
            {recent.length === 0 && (
              <tr>
                <td colSpan={4} className="py-4 text-center text-slate-400">
                  No inwards yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

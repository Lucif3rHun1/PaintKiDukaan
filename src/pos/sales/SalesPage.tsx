// Sales page — quotation toggle + final bill cart.
// E25–E30 / E31–E46 acceptance: see plan §7.3, §15.

import { useMemo, useState } from "react";
import { createSale, convertQuotation, getSale, listSales } from "../api";
import type { CartLine, NewSale, PaymentSplit, Sale } from "../types";

interface Props {
  user: { id: number; name: string; role: "owner" | "cashier" | "stocker" };
}

const DEMO_ITEM_IDS = [1, 2];

export default function SalesPage({ user }: Props) {
  const [kind, setKind] = useState<"quotation" | "final">("final");
  const [lines, setLines] = useState<CartLine[]>([]);
  const [billDiscount, setBillDiscount] = useState(0);
  const [paidAmount, setPaidAmount] = useState(0);
  const [paymentMode, setPaymentMode] = useState<"cash" | "upi" | "card" | "bank" | "cheque">("cash");
  const [ackFlag, setAckFlag] = useState(false);
  const [recent, setRecent] = useState<Sale[]>([]);
  const [status, setStatus] = useState<string | null>(null);

  const total = useMemo(
    () => Math.max(0, lines.reduce((s, l) => Math.max(0, l.qty * l.price - l.line_discount), 0) - billDiscount),
    [lines, billDiscount]
  );

  function addLine(itemId: number, retail: number) {
    setLines((prev) => [
      ...prev,
      { item_id: itemId, qty: 1, price: retail, unit_type: "unit", line_discount: 0, shade_note: null },
    ]);
  }

  async function submit() {
    const req: NewSale = {
      customer_id: null,
      kind,
      bill_discount: billDiscount,
      paid_amount: kind === "quotation" ? 0 : paidAmount,
      payment_modes: kind === "quotation" ? [] : [{ mode: paymentMode, amount: paidAmount } as PaymentSplit],
      validity_days: 7,
      acknowledge_flag: ackFlag,
      lines,
    };
    try {
      const id = await createSale(req);
      const sale = await getSale(id);
      setStatus(`${kind === "quotation" ? "QTN" : "INV"} ${sale?.no ?? id} saved`);
      setLines([]);
      setBillDiscount(0);
      setPaidAmount(0);
      setRecent(await listSales());
    } catch (e) {
      setStatus(`Error: ${String(e)}`);
    }
  }

  async function convert(id: number) {
    try {
      const newId = await convertQuotation({
        quotation_id: id,
        paid_amount: 0,
        payment_modes: [],
        acknowledge_flag: false,
      });
      setStatus(`Quotation ${id} converted → INV ${newId}`);
      setRecent(await listSales());
    } catch (e) {
      setStatus(`Convert failed: ${String(e)}`);
    }
  }

  return (
    <div className="grid grid-cols-3 gap-4">
      <section className="col-span-2 rounded border border-slate-200 bg-white p-4">
        <div className="mb-3 flex gap-2">
          {(["final", "quotation"] as const).map((k) => (
            <button
              key={k}
              data-testid={`kind-${k}`}
              onClick={() => setKind(k)}
              className={
                "rounded px-3 py-1.5 text-sm font-medium " +
                (kind === k ? "bg-slate-900 text-white" : "border border-slate-300")
              }
            >
              {k === "final" ? "Final bill" : "Quotation"}
            </button>
          ))}
        </div>
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th>Item</th>
              <th>Qty</th>
              <th>Price</th>
              <th>Disc</th>
              <th>Total</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className="border-t border-slate-100">
                <td className="py-1">#{l.item_id}</td>
                <td>
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    value={l.qty}
                    onChange={(e) => {
                      const q = Number(e.target.value);
                      setLines((p) => p.map((x, j) => (j === i ? { ...x, qty: q } : x)));
                    }}
                    className="w-16 rounded border border-slate-300 px-1"
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min="0"
                    value={l.price}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setLines((p) => p.map((x, j) => (j === i ? { ...x, price: v } : x)));
                    }}
                    className="w-24 rounded border border-slate-300 px-1"
                    disabled={user.role !== "owner" && kind === "final"}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min="0"
                    value={l.line_discount}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setLines((p) => p.map((x, j) => (j === i ? { ...x, line_discount: v } : x)));
                    }}
                    className="w-20 rounded border border-slate-300 px-1"
                  />
                </td>
                <td>₹{(l.qty * l.price - l.line_discount) / 100}</td>
                <td>
                  <button
                    onClick={() => setLines((p) => p.filter((_, j) => j !== i))}
                    className="text-red-600 hover:underline"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-slate-500">Add demo items:</span>
          {DEMO_ITEM_IDS.map((id) => (
            <button
              key={id}
              onClick={() => addLine(id, 10000)}
              className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-50"
              data-testid={`add-item-${id}`}
            >
              + Item #{id}
            </button>
          ))}
        </div>
      </section>
      <aside className="rounded border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-600">Bill</h2>
        <div className="mt-2 flex justify-between text-sm">
          <span>Subtotal</span>
          <span data-testid="subtotal">₹{(total + billDiscount) / 100}</span>
        </div>
        <div className="mt-1 flex items-center justify-between text-sm">
          <span>Bill discount</span>
          <input
            type="number"
            min="0"
            value={billDiscount}
            onChange={(e) => setBillDiscount(Number(e.target.value))}
            className="w-24 rounded border border-slate-300 px-1"
            disabled={user.role !== "owner"}
            data-testid="bill-discount"
          />
        </div>
        <div className="mt-1 flex justify-between border-t border-slate-200 pt-1 text-base font-semibold">
          <span>Total</span>
          <span data-testid="total">₹{total / 100}</span>
        </div>
        {kind === "final" && (
          <>
            <div className="mt-3 flex items-center justify-between text-sm">
              <span>Paid</span>
              <input
                type="number"
                min="0"
                value={paidAmount}
                onChange={(e) => setPaidAmount(Number(e.target.value))}
                className="w-24 rounded border border-slate-300 px-1"
                data-testid="paid-amount"
              />
            </div>
            <div className="mt-1 flex items-center justify-between text-sm">
              <span>Mode</span>
              <select
                value={paymentMode}
                onChange={(e) => setPaymentMode(e.target.value as typeof paymentMode)}
                className="rounded border border-slate-300 px-1"
              >
                <option value="cash">Cash</option>
                <option value="upi">UPI</option>
                <option value="card">Card</option>
                <option value="bank">Bank</option>
                <option value="cheque">Cheque</option>
              </select>
            </div>
          </>
        )}
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={ackFlag} onChange={(e) => setAckFlag(e.target.checked)} />
          Proceed past flagged-customer warning
        </label>
        <button
          onClick={submit}
          disabled={lines.length === 0}
          className="mt-3 w-full rounded bg-emerald-600 py-2 font-semibold text-white disabled:opacity-50"
          data-testid="submit-sale"
        >
          {kind === "final" ? "Save bill" : "Save quotation"}
        </button>
        {status && <p className="mt-2 text-xs text-slate-600" data-testid="sale-status">{status}</p>}
      </aside>
      <section className="col-span-3 rounded border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-600">Recent bills</h2>
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th>No</th>
              <th>Date</th>
              <th>Status</th>
              <th>Total</th>
              <th>Paid</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {recent.map((s) => (
              <tr key={s.id} className="border-t border-slate-100">
                <td className="font-mono">{s.no}</td>
                <td>{s.date}</td>
                <td>{s.status}</td>
                <td>₹{s.total / 100}</td>
                <td>₹{s.paid_amount / 100}</td>
                <td>
                  {s.status === "quotation" && (
                    <button
                      onClick={() => convert(s.id)}
                      className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-50"
                    >
                      Convert → bill
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {recent.length === 0 && (
              <tr>
                <td colSpan={6} className="py-4 text-center text-slate-400">
                  No bills yet — click an item, then "Save bill".
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

// Held / parked bills — list, restore, delete.
// E45–E46 acceptance: see plan §7.3.

import { useEffect, useState } from "react";
import { deleteHeld, listHeld } from "../api";
import type { HeldBill } from "../types";

interface Props {
  user: { id: number; name: string; role: "owner" | "cashier" | "stocker" };
}

export default function HeldBillsPage({ user }: Props) {
  const [items, setItems] = useState<HeldBill[]>([]);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    listHeld().then(setItems).catch(() => {});
  }, []);

  async function remove(id: number) {
    try {
      const ok = await deleteHeld(id);
      if (ok) {
        setItems(await listHeld());
        setStatus(`Removed #${id}`);
      }
    } catch (e) {
      setStatus(`Delete failed: ${String(e)}`);
    }
  }

  return (
    <div className="rounded border border-slate-200 bg-white p-4">
      <h2 className="mb-2 text-sm font-semibold">Held bills</h2>
      {status && <p className="mb-2 text-xs text-slate-600">{status}</p>}
      <table className="w-full text-sm">
        <thead className="text-left text-slate-500">
          <tr>
            <th>#</th>
            <th>Note</th>
            <th>Created</th>
            <th>Payload (preview)</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((h) => {
            let preview = "(empty)";
            try {
              const parsed = JSON.parse(h.payload_json);
              const lines = Array.isArray(parsed?.lines) ? parsed.lines.length : 0;
              preview = `${lines} line${lines === 1 ? "" : "s"}`;
            } catch {}
            return (
              <tr key={h.id} className="border-t border-slate-100">
                <td>{h.id}</td>
                <td>{h.note ?? <span className="text-slate-400">—</span>}</td>
                <td>{h.created_at}</td>
                <td>{preview}</td>
                <td>
                  <button
                    onClick={() => remove(h.id)}
                    className="text-rose-600 hover:underline"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            );
          })}
          {items.length === 0 && (
            <tr>
              <td colSpan={5} className="py-4 text-center text-slate-400">
                No held bills. Use "Hold" from a sale screen to park one.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

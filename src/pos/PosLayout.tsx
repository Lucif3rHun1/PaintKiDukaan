// POS layout shell — top tabs for the POS slice.
// Rendered as a sibling of the bootstrap state in App.tsx when the app is
// unlocked. Sales tab is default. Quotation toggle lives inside the Sales
// page (per §7.3: same screen, kind toggle).

import { useState } from "react";
import SalesPage from "./sales/SalesPage";
import InwardPage from "./purchases/InwardPage";
import DayClosePage from "./dayClose/DayClosePage";
import ReportsPage from "./reports/ReportsPage";
import HeldBillsPage from "./heldBills/HeldBillsPage";

type Tab = "sales" | "inward" | "held" | "dayclose" | "reports";

export interface PosLayoutProps {
  user: { id: number; name: string; role: "owner" | "cashier" | "stocker" };
  onLock: () => void;
}

export default function PosLayout({ user, onLock }: PosLayoutProps) {
  const [tab, setTab] = useState<Tab>("sales");
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3 shadow-sm">
        <div>
          <h1 className="text-lg font-semibold">PaintKiDukaan · POS</h1>
          <p className="text-xs text-slate-500">
            {user.name} ({user.role})
          </p>
        </div>
        <nav className="flex gap-1">
          {(["sales", "inward", "held", "dayclose", "reports"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={
                "rounded px-3 py-1.5 text-sm font-medium " +
                (tab === t
                  ? "bg-slate-900 text-white"
                  : "text-slate-600 hover:bg-slate-100")
              }
              data-testid={`tab-${t}`}
            >
              {LABELS[t]}
            </button>
          ))}
        </nav>
        <button
          onClick={onLock}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
          data-testid="lock-now"
        >
          Lock
        </button>
      </header>
      <main className="p-4">
        {tab === "sales" && <SalesPage user={user} />}
        {tab === "inward" && <InwardPage user={user} />}
        {tab === "held" && <HeldBillsPage user={user} />}
        {tab === "dayclose" && <DayClosePage user={user} />}
        {tab === "reports" && <ReportsPage user={user} />}
      </main>
    </div>
  );
}

const LABELS: Record<Tab, string> = {
  sales: "Sales",
  inward: "Inward",
  held: "Held bills",
  dayclose: "Day close",
  reports: "Reports",
};

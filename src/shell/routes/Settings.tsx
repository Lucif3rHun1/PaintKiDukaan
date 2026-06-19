import { useState } from "react";

import { BackupPanel } from "../backup/BackupPanel";
import { MasterHealthPage } from "../health/MasterHealthPage";
import { EmptyState } from "../components/EmptyState";

type Tab =
  | "shop"
  | "label"
  | "receipt"
  | "users"
  | "devices"
  | "locations"
  | "customer-types"
  | "backup"
  | "security"
  | "scanner"
  | "master-health";

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "shop", label: "Shop" },
  { id: "label", label: "Label" },
  { id: "receipt", label: "Receipt" },
  { id: "users", label: "Users" },
  { id: "devices", label: "Devices" },
  { id: "locations", label: "Locations" },
  { id: "customer-types", label: "Customer types" },
  { id: "backup", label: "Backup" },
  { id: "security", label: "Security" },
  { id: "scanner", label: "Scanner" },
  { id: "master-health", label: "Master health" },
];

export function Settings() {
  const [tab, setTab] = useState<Tab>("shop");

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Settings</h2>
      <div className="flex flex-wrap gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            type="button"
            key={t.id}
            onClick={() => setTab(t.id)}
            className={
              "rounded-t-md px-3 py-1.5 text-sm " +
              (tab === t.id
                ? "border border-slate-200 border-b-white bg-white font-medium"
                : "text-slate-600 hover:bg-slate-100")
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="rounded-md border border-slate-200 bg-white p-4">
        {tab === "shop" && <ShopTab />}
        {tab === "label" && <PlaceholderTab name="Label" />}
        {tab === "receipt" && <PlaceholderTab name="Receipt" />}
        {tab === "users" && <PlaceholderTab name="Users" />}
        {tab === "devices" && <PlaceholderTab name="Devices" />}
        {tab === "locations" && <PlaceholderTab name="Locations" />}
        {tab === "customer-types" && <PlaceholderTab name="Customer types" />}
        {tab === "backup" && <BackupPanel />}
        {tab === "security" && <PlaceholderTab name="Security" />}
        {tab === "scanner" && <PlaceholderTab name="Scanner" />}
        {tab === "master-health" && <MasterHealthPage />}
      </div>
    </div>
  );
}

function ShopTab() {
  return (
    <div className="space-y-3 text-sm text-slate-700">
      <p>Shop name, address, phone, GSTIN. Editable by owner only.</p>
      <EmptyState
        title="Shop settings form coming in M1.2"
        body="Reads/writes the `settings` row (Slice A)."
      />
    </div>
  );
}

function PlaceholderTab({ name }: { name: string }) {
  return (
    <EmptyState
      title={`${name} tab`}
      body="UI lands in the corresponding slice. The Rust command surface for this tab is already wired in lib.rs."
    />
  );
}

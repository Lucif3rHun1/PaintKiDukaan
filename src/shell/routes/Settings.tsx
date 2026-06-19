import { useEffect, useState, type ReactNode } from "react";

import { BackupPanel } from "../backup/BackupPanel";
import { MasterHealthPage } from "../health/MasterHealthPage";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ipc, type Device, type Role, type User } from "../lib/ipc";

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

const ROLES: Role[] = ["owner", "admin", "cashier", "stocker"];

async function loadString(key: string, fallback = ""): Promise<string> {
  const raw = await ipc.getSetting(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function loadNumber(key: string, fallback = 0): Promise<number> {
  const raw = await ipc.getSetting(key);
  if (!raw) return fallback;
  const n = Number(JSON.parse(raw));
  return Number.isFinite(n) ? n : fallback;
}

async function loadBool(key: string, fallback = false): Promise<boolean> {
  const raw = await ipc.getSetting(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function saveSetting(key: string, value: unknown): Promise<void> {
  await ipc.setSetting(key, JSON.stringify(value));
}

export function Settings() {
  const [tab, setTab] = useState<Tab>("shop");

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Settings</h2>
      <div className="overflow-x-auto">
        <div className="flex gap-1 border-b border-slate-200 min-w-max">
          {TABS.map((t) => (
            <button
              type="button"
              key={t.id}
              onClick={() => setTab(t.id)}
              className={
                "rounded-t-md px-3 py-1.5 text-sm whitespace-nowrap " +
                (tab === t.id
                  ? "border border-slate-200 border-b-white bg-white font-medium"
                  : "text-slate-600 hover:bg-slate-100")
              }
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="rounded-md border border-slate-200 bg-white p-4">
        {tab === "shop" && <ShopTab />}
        {tab === "label" && <LabelTab />}
        {tab === "receipt" && <ReceiptTab />}
        {tab === "users" && <UsersTab />}
        {tab === "devices" && <DevicesTab />}
        {tab === "locations" && <LocationsTab />}
        {tab === "customer-types" && <CustomerTypesTab />}
        {tab === "backup" && <BackupPanel />}
        {tab === "security" && <SecurityTab />}
        {tab === "scanner" && <ScannerTab />}
        {tab === "master-health" && <MasterHealthPage />}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="text-slate-600">{label}</span>
      {children}
    </label>
  );
}

function useFlash() {
  const [msg, setMsg] = useState<string | null>(null);
  const flash = (text: string) => {
    setMsg(text);
    window.setTimeout(() => setMsg(null), 2500);
  };
  return { msg, flash };
}

function ShopTab() {
  const [shopName, setShopName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [gstin, setGstin] = useState("");
  const [currency, setCurrency] = useState("INR");
  const [taxInclusive, setTaxInclusive] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const { msg, flash } = useFlash();

  useEffect(() => {
    let mounted = true;
    Promise.all([
      loadString("shop_name"),
      loadString("shop_address"),
      loadString("shop_phone"),
      loadString("shop_gstin"),
      loadString("currency", "INR"),
      loadBool("tax_inclusive", false),
    ]).then(([n, a, p, g, c, t]) => {
      if (!mounted) return;
      setShopName(n);
      setAddress(a);
      setPhone(p);
      setGstin(g);
      setCurrency(c);
      setTaxInclusive(t);
      setLoaded(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const save = async () => {
    await Promise.all([
      saveSetting("shop_name", shopName.trim()),
      saveSetting("shop_address", address.trim()),
      saveSetting("shop_phone", phone.trim()),
      saveSetting("shop_gstin", gstin.trim().toUpperCase()),
      saveSetting("currency", currency.trim().toUpperCase() || "INR"),
      saveSetting("tax_inclusive", taxInclusive),
    ]);
    flash("Shop settings saved.");
  };

  if (!loaded) return <Skeleton />;

  return (
    <div className="space-y-4 text-sm">
      <h3 className="text-base font-semibold">Shop details</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Shop name">
          <input
            type="text"
            value={shopName}
            onChange={(e) => setShopName(e.target.value)}
            className="w-full rounded-md border border-slate-300 p-2"
          />
        </Field>
        <Field label="Currency">
          <input
            type="text"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            className="w-full rounded-md border border-slate-300 p-2"
            placeholder="INR"
          />
        </Field>
        <Field label="Phone">
          <input
            type="text"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full rounded-md border border-slate-300 p-2"
          />
        </Field>
        <Field label="GSTIN">
          <input
            type="text"
            value={gstin}
            onChange={(e) => setGstin(e.target.value)}
            className="w-full rounded-md border border-slate-300 p-2"
          />
        </Field>
        <Field label="Address">
          <textarea
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-slate-300 p-2"
          />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={taxInclusive}
          onChange={(e) => setTaxInclusive(e.target.checked)}
          className="h-4 w-4"
        />
        Tax-inclusive pricing
      </label>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          Save shop settings
        </button>
        {msg && <span className="text-emerald-600">{msg}</span>}
      </div>
    </div>
  );
}

function LabelTab() {
  const [template, setTemplate] = useState("");
  const [loaded, setLoaded] = useState(false);
  const { msg, flash } = useFlash();

  useEffect(() => {
    loadString("label_template").then((t) => {
      setTemplate(t);
      setLoaded(true);
    });
  }, []);

  const save = async () => {
    await saveSetting("label_template", template);
    flash("Label template saved.");
  };

  if (!loaded) return <Skeleton />;

  return (
    <div className="space-y-4 text-sm">
      <h3 className="text-base font-semibold">Label template</h3>
      <Field label="Template">
        <textarea
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          rows={8}
          className="w-full rounded-md border border-slate-300 p-2 font-mono"
        />
      </Field>
      <p className="text-xs text-slate-500">
        Use {"{name}"}, {"{mrp}"}, {"{sku}"}, {"{barcode}"} as placeholders.
      </p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          Save label template
        </button>
        {msg && <span className="text-emerald-600">{msg}</span>}
      </div>
    </div>
  );
}

function ReceiptTab() {
  const [header, setHeader] = useState("");
  const [footer, setFooter] = useState("");
  const [terms, setTerms] = useState("");
  const [loaded, setLoaded] = useState(false);
  const { msg, flash } = useFlash();

  useEffect(() => {
    Promise.all([
      loadString("receipt_header"),
      loadString("receipt_footer"),
      loadString("receipt_terms"),
    ]).then(([h, f, t]) => {
      setHeader(h);
      setFooter(f);
      setTerms(t);
      setLoaded(true);
    });
  }, []);

  const save = async () => {
    await Promise.all([
      saveSetting("receipt_header", header),
      saveSetting("receipt_footer", footer),
      saveSetting("receipt_terms", terms),
    ]);
    flash("Receipt settings saved.");
  };

  if (!loaded) return <Skeleton />;

  return (
    <div className="space-y-4 text-sm">
      <h3 className="text-base font-semibold">Receipt</h3>
      <div className="grid gap-4">
        <Field label="Header">
          <textarea
            value={header}
            onChange={(e) => setHeader(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-slate-300 p-2"
          />
        </Field>
        <Field label="Footer">
          <textarea
            value={footer}
            onChange={(e) => setFooter(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-slate-300 p-2"
          />
        </Field>
        <Field label="Terms">
          <textarea
            value={terms}
            onChange={(e) => setTerms(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-slate-300 p-2"
          />
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          Save receipt settings
        </button>
        {msg && <span className="text-emerald-600">{msg}</span>}
      </div>
    </div>
  );
}

function UsersTab() {
  const [users, setUsers] = useState<User[]>([]);
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("cashier");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState<User | null>(null);

  const refresh = () => {
    ipc
      .listUsers()
      .then(setUsers)
      .catch((e: unknown) => setError(String(e)));
  };

  useEffect(refresh, []);

  const add = async () => {
    setError(null);
    try {
      await ipc.createUser(name.trim(), role, pin);
      setName("");
      setPin("");
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const reset = async (newPin: string) => {
    if (!resetting) return;
    setError(null);
    try {
      await ipc.resetPin(resetting.id, newPin);
      setResetting(null);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="space-y-4 text-sm">
      <h3 className="text-base font-semibold">Users</h3>

      <div className="space-y-3 rounded-md border border-slate-200 p-3">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Name">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-slate-300 p-2"
            />
          </Field>
          <Field label="Role">
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              className="w-full rounded-md border border-slate-300 p-2"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
          <Field label="PIN (4-10 digits)">
            <input
              type="password"
              inputMode="numeric"
              maxLength={10}
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              className="w-full rounded-md border border-slate-300 p-2"
            />
          </Field>
          <div className="flex items-end">
            <button
              type="button"
              onClick={() => void add()}
              disabled={!name.trim() || pin.length < 4}
              className="w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Add user
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <table className="w-full text-left text-sm">
        <thead className="border-b border-slate-200 text-slate-500">
          <tr>
            <th className="py-2 pr-3">Name</th>
            <th className="py-2 pr-3">Role</th>
            <th className="py-2 pr-3">Status</th>
            <th className="py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-b border-slate-100">
              <td className="py-2 pr-3">{u.name}</td>
              <td className="py-2 pr-3 capitalize">{u.role}</td>
              <td className="py-2 pr-3">
                {u.is_active ? (
                  <span className="text-emerald-600">active</span>
                ) : (
                  <span className="text-slate-500">inactive</span>
                )}
              </td>
              <td className="py-2 text-right">
                <button
                  type="button"
                  onClick={() => setResetting(u)}
                  className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50"
                >
                  Reset PIN
                </button>
              </td>
            </tr>
          ))}
          {users.length === 0 && (
            <tr>
              <td colSpan={4} className="py-4 text-center text-slate-500">
                No users yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <ConfirmDialog
        open={resetting !== null}
        title={`Reset PIN for ${resetting?.name ?? ""}`}
        body="A prompt will ask for the new 4–10 digit PIN."
        confirmLabel="Continue"
        onConfirm={() => {
          const newPin = window.prompt("New PIN (4-10 digits)");
          if (newPin) void reset(newPin);
          else setResetting(null);
        }}
        onCancel={() => setResetting(null)}
      />
    </div>
  );
}

function DevicesTab() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("cashier");
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<Device | null>(null);

  const refresh = () => {
    ipc
      .listDevices()
      .then(setDevices)
      .catch((e: unknown) => setError(String(e)));
  };

  useEffect(refresh, []);

  const add = async () => {
    setError(null);
    try {
      await ipc.enrollDevice(name.trim(), role);
      setName("");
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const revoke = async () => {
    if (!revoking) return;
    setError(null);
    try {
      await ipc.revokeDevice(revoking.id);
      setRevoking(null);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="space-y-4 text-sm">
      <h3 className="text-base font-semibold">Devices</h3>

      <div className="space-y-3 rounded-md border border-slate-200 p-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Device name">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-slate-300 p-2"
            />
          </Field>
          <Field label="Role">
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              className="w-full rounded-md border border-slate-300 p-2"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex items-end">
            <button
              type="button"
              onClick={() => void add()}
              disabled={!name.trim()}
              className="w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Enroll device
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <table className="w-full text-left text-sm">
        <thead className="border-b border-slate-200 text-slate-500">
          <tr>
            <th className="py-2 pr-3">ID</th>
            <th className="py-2 pr-3">Name</th>
            <th className="py-2 pr-3">Role</th>
            <th className="py-2 pr-3">Status</th>
            <th className="py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {devices.map((d) => (
            <tr key={d.id} className="border-b border-slate-100">
              <td className="py-2 pr-3 font-mono text-xs">{d.id}</td>
              <td className="py-2 pr-3">{d.name}</td>
              <td className="py-2 pr-3 capitalize">{d.role}</td>
              <td className="py-2 pr-3">
                {d.is_active ? (
                  <span className="text-emerald-600">active</span>
                ) : (
                  <span className="text-slate-500">revoked</span>
                )}
              </td>
              <td className="py-2 text-right">
                {d.is_active && (
                  <button
                    type="button"
                    onClick={() => setRevoking(d)}
                    className="rounded-md border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                  >
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
          {devices.length === 0 && (
            <tr>
              <td colSpan={5} className="py-4 text-center text-slate-500">
                No devices enrolled.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <ConfirmDialog
        open={revoking !== null}
        title={`Revoke ${revoking?.name ?? ""}?`}
        body="This device will no longer be able to unlock the app."
        destructive
        confirmLabel="Revoke"
        onConfirm={() => void revoke()}
        onCancel={() => setRevoking(null)}
      />
    </div>
  );
}

function LocationsTab() {
  const [locations, setLocations] = useState<string[]>([]);
  const [newLocation, setNewLocation] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    ipc
      .listLocations()
      .then(setLocations)
      .catch((e: unknown) => setError(String(e)));
  };

  useEffect(refresh, []);

  const add = async () => {
    const trimmed = newLocation.trim();
    if (!trimmed) return;
    setError(null);
    try {
      const updated = await ipc.addLocation(trimmed);
      setLocations(updated);
      setNewLocation("");
    } catch (e) {
      setError(String(e));
    }
  };

  const remove = async (location: string) => {
    setError(null);
    try {
      const updated = await ipc.removeLocation(location);
      setLocations(updated);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="space-y-4 text-sm">
      <h3 className="text-base font-semibold">Locations</h3>

      <div className="flex gap-2">
        <input
          type="text"
          value={newLocation}
          onChange={(e) => setNewLocation(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
          placeholder="New location name"
          className="flex-1 rounded-md border border-slate-300 p-2"
        />
        <button
          type="button"
          onClick={() => void add()}
          disabled={!newLocation.trim()}
          className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Add
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <ul className="divide-y divide-slate-200 rounded-md border border-slate-200">
        {locations.map((loc) => (
          <li key={loc} className="flex items-center justify-between px-3 py-2">
            <span>{loc}</span>
            <button
              type="button"
              onClick={() => void remove(loc)}
              className="text-xs text-red-600 hover:text-red-800"
            >
              Remove
            </button>
          </li>
        ))}
        {locations.length === 0 && (
          <li className="px-3 py-4 text-center text-slate-500">
            No locations configured.
          </li>
        )}
      </ul>
    </div>
  );
}

function CustomerTypesTab() {
  const [customerTypes, setCustomerTypes] = useState<string[]>([]);
  const [newType, setNewType] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    ipc
      .listCustomerTypes()
      .then(setCustomerTypes)
      .catch((e: unknown) => setError(String(e)));
  };

  useEffect(refresh, []);

  const add = async () => {
    const trimmed = newType.trim();
    if (!trimmed) return;
    setError(null);
    try {
      const updated = await ipc.addCustomerType(trimmed);
      setCustomerTypes(updated);
      setNewType("");
    } catch (e) {
      setError(String(e));
    }
  };

  const remove = async (customerType: string) => {
    setError(null);
    try {
      const updated = await ipc.removeCustomerType(customerType);
      setCustomerTypes(updated);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="space-y-4 text-sm">
      <h3 className="text-base font-semibold">Customer Types</h3>

      <div className="flex gap-2">
        <input
          type="text"
          value={newType}
          onChange={(e) => setNewType(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
          placeholder="New customer type"
          className="flex-1 rounded-md border border-slate-300 p-2"
        />
        <button
          type="button"
          onClick={() => void add()}
          disabled={!newType.trim()}
          className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Add
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <ul className="divide-y divide-slate-200 rounded-md border border-slate-200">
        {customerTypes.map((ct) => (
          <li key={ct} className="flex items-center justify-between px-3 py-2">
            <span>{ct}</span>
            <button
              type="button"
              onClick={() => void remove(ct)}
              className="text-xs text-red-600 hover:text-red-800"
            >
              Remove
            </button>
          </li>
        ))}
        {customerTypes.length === 0 && (
          <li className="px-3 py-4 text-center text-slate-500">
            No customer types configured.
          </li>
        )}
      </ul>
    </div>
  );
}

function ScannerTab() {
  const [minLen, setMinLen] = useState(4);
  const [avgMs, setAvgMs] = useState(25);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { msg, flash } = useFlash();

  useEffect(() => {
    Promise.all([
      loadNumber("scanner_min_length", 4),
      loadNumber("scanner_avg_ms_per_char", 25),
    ])
      .then(([l, a]) => {
        setMinLen(l);
        setAvgMs(a);
        setLoaded(true);
      })
      .catch((e: unknown) => setError(String(e)));
  }, []);

  const save = async () => {
    await Promise.all([
      saveSetting("scanner_min_length", Math.max(1, minLen)),
      saveSetting("scanner_avg_ms_per_char", Math.max(5, avgMs)),
    ]);
    flash("Scanner settings saved.");
  };

  if (!loaded) return <Skeleton />;

  return (
    <div className="space-y-4 text-sm">
      <h3 className="text-base font-semibold">Scanner wedge</h3>
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">
          {error}
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Minimum barcode length">
          <input
            type="number"
            min={1}
            value={minLen}
            onChange={(e) => setMinLen(Number(e.target.value))}
            className="w-full rounded-md border border-slate-300 p-2"
          />
        </Field>
        <Field label="Average ms per character">
          <input
            type="number"
            min={5}
            max={200}
            value={avgMs}
            onChange={(e) => setAvgMs(Number(e.target.value))}
            className="w-full rounded-md border border-slate-300 p-2"
          />
        </Field>
      </div>
      <p className="text-xs text-slate-500">
        Detection rule: terminator seen, length ≥ minimum, and total time ≤
        max(150 ms, length × avg ms/char).
      </p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          Save scanner settings
        </button>
        {msg && <span className="text-emerald-600">{msg}</span>}
      </div>
    </div>
  );
}

function SecurityTab() {
  const [idle, setIdle] = useState(5);
  const [lockoutAction, setLockoutAction] = useState("lock");
  const [lockoutTimeout, setLockoutTimeout] = useState(30);
  const [loaded, setLoaded] = useState(false);
  const { msg, flash } = useFlash();

  useEffect(() => {
    Promise.all([
      loadNumber("idle_lock_minutes", 5),
      loadString("lockout_action", "lock"),
      loadNumber("lockout_timeout_minutes", 30),
    ]).then(([i, a, t]) => {
      setIdle(i);
      setLockoutAction(a);
      setLockoutTimeout(t);
      setLoaded(true);
    });
  }, []);

  const save = async () => {
    await Promise.all([
      saveSetting("idle_lock_minutes", Math.max(1, idle)),
      saveSetting("lockout_action", lockoutAction),
      saveSetting("lockout_timeout_minutes", Math.max(1, lockoutTimeout)),
    ]);
    flash("Security settings saved.");
  };

  if (!loaded) return <Skeleton />;

  return (
    <div className="space-y-4 text-sm">
      <h3 className="text-base font-semibold">Security</h3>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Idle auto-lock (minutes)">
          <input
            type="number"
            min={1}
            value={idle}
            onChange={(e) => setIdle(Number(e.target.value))}
            className="w-full rounded-md border border-slate-300 p-2"
          />
        </Field>
        <Field label="Lockout action">
          <select
            value={lockoutAction}
            onChange={(e) => setLockoutAction(e.target.value)}
            className="w-full rounded-md border border-slate-300 p-2"
          >
            <option value="lock">Lock</option>
            <option value="logout">Logout</option>
          </select>
        </Field>
        <Field label="Lockout timeout (minutes)">
          <input
            type="number"
            min={1}
            value={lockoutTimeout}
            onChange={(e) => setLockoutTimeout(Number(e.target.value))}
            className="w-full rounded-md border border-slate-300 p-2"
          />
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          Save security settings
        </button>
        {msg && <span className="text-emerald-600">{msg}</span>}
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-3">
      <div className="h-4 w-1/3 rounded bg-slate-200" />
      <div className="h-20 rounded bg-slate-100" />
      <div className="h-20 rounded bg-slate-100" />
    </div>
  );
}

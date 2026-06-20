import { tauriInvoke as invoke } from "./lib/security/tauri";
import { initSessionLog } from "./lib/security/sessionLog";
import logo from "./assets/logo-64.png";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/* ── Security UI ─────────────────────────────────────────── */
import { FirstLaunch } from "./lib/security/firstLaunch";
import { LockScreen } from "./lib/security/lockScreen";
import { RestoreFromRecovery } from "./lib/security/restoreFromRecovery";
import { type Bootstrap, useSecurity } from "./lib/security/state";
import { UserManagement } from "./lib/security/userManagement";

/* ── Domain UI (Slice B) ─────────────────────────────────── */
import { ItemList } from "./domain/items/ItemList";
import { BulkLabelsPage } from "./domain/items/BulkLabelsPage";
import { BrandAdmin } from "./domain/items/BrandAdmin";
import { CustomerList } from "./domain/customers/CustomerList";
import { CustomerForm } from "./domain/customers/CustomerForm";
import { VendorList } from "./domain/vendors/VendorList";
import { VendorForm } from "./domain/vendors/VendorForm";
import { customerOutstanding } from "./domain/customers/api";
import { listCustomerTypes } from "./domain/customerTypes/api";
/* ── POS UI (Slice C) ────────────────────────────────────── */
import SalesPage from "./pos/sales/SalesPage";
import InwardPage from "./pos/purchases/InwardPage";
import SalesReportPage from "./pos/salesReport/SalesReportPage";

/* ── Shell UI (Slice D) ──────────────────────────────────── */
import { Dashboard } from "./shell/routes/Dashboard";
import { Settings as SettingsPage } from "./shell/routes/Settings";
import { AdminLogs } from "./shell/routes/AdminLogs";
import { MasterHealthPage } from "./shell/health/MasterHealthPage";
import { AppShell, type AppShellTab } from "./shell/AppShell";
import { InlineDialog } from "./components/ui/InlineDialog";
import type { Customer, CustomerType, Vendor } from "./domain/types";

const THIRTY_SECONDS = 30_000;
const FIFTEEN_MINUTES = 15 * 60 * 1_000;
const LOCKED_SESSION = { user: null, locked: true } as const;

/* ── Hash routing ───────────────────────────────────────── */
const HASH_REDIRECTS: Record<string, string> = {
  "#/pos": "#/sales",
  "#/pos/inward": "#/inward",
  "#/pos/held": "#/sales",
  "#/pos/dayclose": "#/sales-report",
  "#/pos/day-close": "#/sales-report",
  "#/pos/reports": "#/sales-report",
};

function readTab(): AppShellTab {
  const h = typeof window !== "undefined" ? window.location.hash : "";
  if (h.startsWith("#/sales-report")) return "sales-report";
  if (h.startsWith("#/inward")) return "inward";
  if (h.startsWith("#/sales")) return "sales";
  if (h.startsWith("#/items")) return "items";
  if (h.startsWith("#/customers")) return "customers";
  if (h.startsWith("#/vendors")) return "vendors";
  if (h.startsWith("#/settings")) return "settings";
  if (h.startsWith("#/health")) return "health";
  if (h.startsWith("#/logs")) return "logs";
  return "dashboard";
}

function readItemsSubRoute(): "list" | "barcodes" | "brands" | "outwards" {
  const h = window.location.hash;
  if (h.startsWith("#/items/barcodes")) return "barcodes";
  if (h.startsWith("#/items/brands")) return "brands";
  if (h.startsWith("#/items/outwards")) return "outwards";
  return "list";
}

function applyHashRedirect(): boolean {
  if (typeof window === "undefined") return false;
  const target = HASH_REDIRECTS[window.location.hash];
  if (target) {
    window.location.replace(target);
    return true;
  }
  return false;
}

export default function App() {
  initSessionLog();
  const phase = useSecurity((s) => s.phase);
  const session = useSecurity((s) => s.session);
  const setPhase = useSecurity((s) => s.setPhase);
  const setSession = useSecurity((s) => s.setSession);
  const lastTouchAt = useRef(0);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [tab, setTab] = useState<AppShellTab>(readTab);

  /* ── Vendor modal state ───────────────────────────────── */
  const [vendorCreateOpen, setVendorCreateOpen] = useState(false);
  const [vendorEditTarget, setVendorEditTarget] = useState<Vendor | null>(null);
  const [vendorDetailTarget, setVendorDetailTarget] = useState<Vendor | null>(null);

  /* ── Customer modal state ─────────────────────────────── */
  const [customerCreateOpen, setCustomerCreateOpen] = useState(false);
  const [customerEditTarget, setCustomerEditTarget] = useState<Customer | null>(null);
  const [customerTypes, setCustomerTypes] = useState<CustomerType[]>([]);

  // Fetch customer types once
  useEffect(() => {
    listCustomerTypes().then(setCustomerTypes).catch(() => {});
  }, []);

  /* ── Bootstrap ─────────────────────────────────────────── */
  useEffect(() => {
    let cancelled = false;
    if (applyHashRedirect()) return;
    console.log("[BOOT] Calling app_bootstrap...");
    invoke<Bootstrap>("app_bootstrap")
      .then((b) => {
        if (cancelled) return;
        console.log("[BOOT] Bootstrap result:", JSON.stringify(b));
        if (b.kind === "first_launch") {
          setSession(LOCKED_SESSION);
          setPhase("first-launch");
        } else if (b.kind === "locked") {
          setSession(LOCKED_SESSION);
          setPhase("locked");
        } else {
          setSession({ user: { id: 0, name: b.user, role: b.role }, locked: false });
          setPhase("unlocked");
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[BOOT] Bootstrap error:", err);
        setBootstrapError(err instanceof Error ? err.message : String(err));
        setSession(LOCKED_SESSION);
        setPhase("locked");
      });
    return () => { cancelled = true; };
  }, [setPhase, setSession]);

  /* ── Hash routing ──────────────────────────────────────── */
  useEffect(() => {
    const onHash = () => setTab(readTab());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  /* ── Activity tracking ─────────────────────────────────── */
  useEffect(() => {
    if (phase !== "unlocked") return;
    const touch = () => {
      const now = Date.now();
      if (now - lastTouchAt.current < THIRTY_SECONDS) return;
      lastTouchAt.current = now;
      void invoke("touch_activity").catch(() => undefined);
    };
    window.addEventListener("mousemove", touch);
    window.addEventListener("keydown", touch);
    window.addEventListener("click", touch);
    return () => {
      window.removeEventListener("mousemove", touch);
      window.removeEventListener("keydown", touch);
      window.removeEventListener("click", touch);
    };
  }, [phase]);

  /* ── Idle auto-lock ────────────────────────────────────── */
  useEffect(() => {
    if (phase !== "unlocked") return;
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try { await invoke("lock"); } finally {
          setSession(LOCKED_SESSION);
          setPhase("locked");
        }
      }, FIFTEEN_MINUTES);
    };
    const onActivity = () => reset();
    window.addEventListener("mousemove", onActivity);
    window.addEventListener("keydown", onActivity);
    window.addEventListener("click", onActivity);
    reset();
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousemove", onActivity);
      window.removeEventListener("keydown", onActivity);
      window.removeEventListener("click", onActivity);
    };
  }, [phase, setPhase, setSession]);

  /* ── Lock action ───────────────────────────────────────── */
  async function lockNow() {
    try { await invoke("lock"); } finally {
      setSession(LOCKED_SESSION);
      setPhase("locked");
    }
  }

  function navigate(t: AppShellTab, hash?: string) {
    setTab(t);
    window.location.hash = hash ?? (t === "dashboard" ? "#/" : `#/${t}`);
  }

  /* ── Security phases ───────────────────────────────────── */
  if (phase === "loading") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-4 text-zinc-100">
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-white/10 bg-zinc-900/80 p-8 backdrop-blur">
          <img
            src={logo}
            alt="PaintKiDukaan"
            className="h-8 w-8 rounded-lg"
          />
          <Loader2 className="h-5 w-5 animate-spin text-indigo-400" aria-hidden="true" />
          <p className="text-sm text-zinc-400">Opening secure shop database…</p>
        </div>
      </main>
    );
  }

  if (phase === "first-launch") return <FirstLaunch />;
  if (phase === "locked") return <LockScreen />;
  if (phase === "restore-recovery") return <RestoreFromRecovery />;
  if (phase === "user-management") return <UserManagement />;

  /* ── Unlocked: full app shell ──────────────────────────── */
  const user = session.user;
  const role = user?.role ?? "owner";

  return (
    <AppShell
      activeTab={tab}
      user={user}
      bootstrapError={bootstrapError}
      onNavigate={navigate}
      onLock={lockNow}
      onLogout={lockNow}
    >
      {tab === "dashboard" && (
        <Dashboard
          user={{ id: user?.id ?? 0, name: user?.name ?? "Owner", role }}
          onNavigate={navigate}
          onLock={lockNow}
        />
      )}
      {tab === "sales" && (
        <SalesPage user={{ id: user?.id ?? 0, name: user?.name ?? "Owner", role }} />
      )}
      {tab === "inward" && (
        <InwardPage user={{ id: user?.id ?? 0, name: user?.name ?? "Owner", role }} />
      )}
      {tab === "sales-report" && (
        <SalesReportPage user={{ id: user?.id ?? 0, name: user?.name ?? "Owner", role }} />
      )}
      {tab === "items" && (
        <div className="space-y-4">
          <h2 className="text-xl font-semibold">Inventory</h2>
          <ItemSubNav />
          {readItemsSubRoute() === "barcodes" && <BulkLabelsPage />}
          {readItemsSubRoute() === "brands" && <BrandAdmin role={role} />}
          {readItemsSubRoute() === "list" && <ItemList role={role} />}
          {readItemsSubRoute() === "outwards" && (
            <p className="text-sm text-slate-500">Outwards view coming soon.</p>
          )}
        </div>
      )}
      {tab === "vendors" && (
        <div className="space-y-4">
          <h2 className="text-xl font-semibold">Vendors</h2>
          <VendorList
            role={role}
            onCreate={() => setVendorCreateOpen(true)}
            onSelect={(v) => setVendorDetailTarget(v)}
            onRecordPayment={(v) => setVendorEditTarget(v)}
          />
        </div>
      )}
      {tab === "customers" && (
        <div className="space-y-4">
          <h2 className="text-xl font-semibold">Customers</h2>
          <CustomerList
            role={role}
            onCreate={() => setCustomerCreateOpen(true)}
            onSelect={(c) => setCustomerEditTarget(c)}
          />
        </div>
      )}
      {tab === "settings" && <SettingsPage />}
      {tab === "health" && <MasterHealthPage />}
      {tab === "logs" && <AdminLogs />}

      {/* ── Vendor modals ──────────────────────────────── */}
      <InlineDialog
        open={vendorCreateOpen}
        onClose={() => setVendorCreateOpen(false)}
        title="Add Vendor"
      >
        <VendorForm
          mode="create"
          onSaved={(v) => { setVendorCreateOpen(false); setVendorDetailTarget(v); }}
          onCancel={() => setVendorCreateOpen(false)}
        />
      </InlineDialog>

      <InlineDialog
        open={!!vendorEditTarget}
        onClose={() => setVendorEditTarget(null)}
        title="Edit Vendor"
      >
        {vendorEditTarget && (
          <VendorForm
            mode="edit"
            initial={vendorEditTarget}
            onSaved={(v) => { setVendorEditTarget(null); setVendorDetailTarget(v); }}
            onCancel={() => setVendorEditTarget(null)}
          />
        )}
      </InlineDialog>

      <InlineDialog
        open={!!vendorDetailTarget}
        onClose={() => setVendorDetailTarget(null)}
        title="Vendor Details"
        size="lg"
      >
        {vendorDetailTarget && (
          <div className="text-sm text-slate-300">
            Vendor detail for {vendorDetailTarget.name} (id={vendorDetailTarget.id}).
          </div>
        )}
      </InlineDialog>

      {/* ── Customer modals ────────────────────────────── */}
      <InlineDialog
        open={customerCreateOpen}
        onClose={() => setCustomerCreateOpen(false)}
        title="Add Customer"
      >
        <CustomerForm
          mode="create"
          types={customerTypes}
          canFlag={role === "owner"}
          onSaved={(c) => { setCustomerCreateOpen(false); setCustomerEditTarget(c); }}
          onCancel={() => setCustomerCreateOpen(false)}
        />
      </InlineDialog>

      <InlineDialog
        open={!!customerEditTarget}
        onClose={() => setCustomerEditTarget(null)}
        title="Edit Customer"
      >
        {customerEditTarget && (
          <CustomerForm
            mode="edit"
            initial={customerEditTarget}
            types={customerTypes}
            canFlag={role === "owner"}
            onSaved={(c) => setCustomerEditTarget(null)}
            onCancel={() => setCustomerEditTarget(null)}
          />
        )}
      </InlineDialog>
    </AppShell>
  );
}

function ItemSubNav() {
  const sub = readItemsSubRoute();
  const tabs: ReadonlyArray<{ id: "list" | "barcodes" | "brands" | "outwards"; label: string; href: string }> = [
    { id: "list", label: "Items", href: "#/items" },
    { id: "barcodes", label: "Barcode Labels", href: "#/items/barcodes" },
    { id: "brands", label: "Brands", href: "#/items/brands" },
    { id: "outwards", label: "Outwards", href: "#/items/outwards" },
  ];
  return (
    <div className="flex gap-1 border-b border-white/10">
      {tabs.map((t) => (
        <a
          key={t.id}
          href={t.href}
          className={`rounded-t-md px-3 py-1.5 text-sm whitespace-nowrap ${
            sub === t.id
              ? "border border-white/10 border-b-zinc-950 bg-zinc-950 font-medium text-zinc-100"
              : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
          }`}
        >
          {t.label}
        </a>
      ))}
    </div>
  );
}

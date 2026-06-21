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
import { RoleGuard } from "./lib/security/roleGuard";

/* ── Domain UI (Slice B) ─────────────────────────────────── */
import { ItemList } from "./domain/items/ItemList";
import { BulkLabelsPage } from "./domain/items/BulkLabelsPage";
import { BrandAdmin } from "./domain/items/BrandAdmin";
import { CustomerList } from "./domain/customers/CustomerList";
import { CustomerForm } from "./domain/customers/CustomerForm";
import { CustomerDetail } from "./domain/customers/CustomerDetail";
import { CustomerPaymentForm } from "./domain/customers/CustomerPaymentForm";
import { VendorList } from "./domain/vendors/VendorList";
import { VendorForm } from "./domain/vendors/VendorForm";
import { VendorPaymentForm } from "./domain/vendors/VendorPaymentForm";
import { VendorDetail } from "./domain/vendors/VendorDetail";
import { customerOutstanding } from "./domain/customers/api";
import { listCustomerTypes } from "./domain/customerTypes/api";
/* ── POS UI (Slice C) ────────────────────────────────────── */
import SalesPage from "./pos/sales/SalesPage";
import { SalesListPage } from "./pos/sales/SalesListPage";
import ReturnPage from "./pos/sales/ReturnPage";
import InwardPage from "./pos/purchases/InwardPage";
import SalesReportPage from "./pos/salesReport/SalesReportPage";

/* ── Shell UI (Slice D) ──────────────────────────────────── */
import { Dashboard } from "./shell/routes/Dashboard";
import { Settings as SettingsPage } from "./shell/routes/Settings";
import { AdminLogs } from "./shell/routes/AdminLogs";
import { MasterHealthPage } from "./shell/health/MasterHealthPage";
import { AppShell, type AppShellTab } from "./shell/AppShell";
import { InlineDialog } from "./components/ui/InlineDialog";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import type { Customer, CustomerType, Vendor } from "./domain/types";

const THIRTY_SECONDS = 30_000;
const FIFTEEN_MINUTES = 15 * 60 * 1_000;
const LOCKED_SESSION = { user: null, locked: true, pinRole: "real" as const };

/* ── Hash routing ───────────────────────────────────────── */
const HASH_REDIRECTS: Record<string, string> = {
  "#/pos": "#/sales",
  "#/pos/inward": "#/inward",

  "#/pos/dayclose": "#/sales-report",
  "#/pos/day-close": "#/sales-report",
  "#/pos/reports": "#/sales-report",
};

function readTab(): AppShellTab {
  const h = typeof window !== "undefined" ? window.location.hash : "";
  if (h.startsWith("#/sales-report")) return "sales-report";
  if (h.startsWith("#/inward")) return "inward";
  if (h.startsWith("#/sales")) return "sales";
  if (h.startsWith("#/barcodes")) return "barcodes";
  if (h.startsWith("#/items")) return "items";
  if (h.startsWith("#/customers")) return "customers";
  if (h.startsWith("#/vendors")) return "vendors";
  if (h.startsWith("#/settings")) return "settings";
  if (h.startsWith("#/health")) return "health";
  if (h.startsWith("#/logs")) return "logs";
  return "dashboard";
}

function readItemsSubRoute(): "list" | "barcodes" {
  const h = window.location.hash;
  if (h.startsWith("#/items/barcodes")) return "barcodes";
  if (h.startsWith("#/barcodes")) return "barcodes";
  return "list";
}

function readSalesSubRoute(): "list" | "new" | "return" {
  const h = window.location.hash;
  if (h === "#/sales/new") return "new";
  if (h === "#/sales/return") return "return";
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
  const [salesRoute, setSalesRoute] = useState<"list" | "new" | "return">(readSalesSubRoute);

  /* ── Vendor modal state ───────────────────────────────── */
  const [vendorCreateOpen, setVendorCreateOpen] = useState(false);
  const [vendorEditTarget, setVendorEditTarget] = useState<Vendor | null>(null);
  const [vendorDetailTarget, setVendorDetailTarget] = useState<Vendor | null>(null);
  const [vendorPaymentTarget, setVendorPaymentTarget] = useState<Vendor | null>(null);

  /* ── Customer modal state ─────────────────────────────── */
  const [customerCreateOpen, setCustomerCreateOpen] = useState(false);
  const [customerEditTarget, setCustomerEditTarget] = useState<Customer | null>(null);
  const [customerDetailTarget, setCustomerDetailTarget] = useState<Customer | null>(null);
  const [customerPaymentTarget, setCustomerPaymentTarget] = useState<Customer | null>(null);
  const [customerTypes, setCustomerTypes] = useState<CustomerType[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  // Fetch customer types once the app is unlocked
  useEffect(() => {
    if (phase === "unlocked") {
      listCustomerTypes().then(setCustomerTypes).catch(() => {});
    }
  }, [phase]);

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
          setSession({ user: { id: 0, name: b.user, role: b.role }, locked: false, pinRole: b.pin_role ?? "real" });
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
    if (typeof window === "undefined") return;
    if (window.location.hash === "#/items/barcodes") {
      window.location.replace("#/barcodes");
      return;
    }
    const onHash = () => {
      setTab(readTab());
      setSalesRoute(readSalesSubRoute());
    };
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
        <ErrorBoundary context="Dashboard">
          <Dashboard
            user={{ id: user?.id ?? 0, name: user?.name ?? "Owner", role }}
            onNavigate={navigate}
            onLock={lockNow}
          />
        </ErrorBoundary>
      )}
      {tab === "sales" && salesRoute === "new" ? (
        <ErrorBoundary context="Sales — new">
          <SalesPage
            user={{ id: user?.id ?? 0, name: user?.name ?? "Owner", role }}
            onBack={() => (window.location.hash = "#/sales")}
          />
        </ErrorBoundary>
      ) : null}
      {tab === "sales" && salesRoute === "return" ? (
        <ErrorBoundary context="Sales — return">
          <ReturnPage
            user={{ id: user?.id ?? 0, name: user?.name ?? "Owner", role }}
            onBack={() => (window.location.hash = "#/sales")}
          />
        </ErrorBoundary>
      ) : null}
      {tab === "sales" && salesRoute === "list" ? (
        <ErrorBoundary context="Sales — list">
          <SalesListPage onCreate={() => (window.location.hash = "#/sales/new")} />
        </ErrorBoundary>
      ) : null}
      {tab === "inward" && (
        <ErrorBoundary context="Inward">
          <InwardPage user={{ id: user?.id ?? 0, name: user?.name ?? "Owner", role }} />
        </ErrorBoundary>
      )}
      {tab === "sales-report" && (
        <RoleGuard minRole="stocker">
          <ErrorBoundary context="Sales Report">
            <SalesReportPage user={{ id: user?.id ?? 0, name: user?.name ?? "Owner", role }} />
          </ErrorBoundary>
        </RoleGuard>
      )}
      {tab === "items" && (
        <div className="space-y-3">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-semibold text-slate-900">Inventory</h2>
            <ItemSubNav active="items" />
          </div>
          <ErrorBoundary context="Inventory">
            <ItemList role={role} />
          </ErrorBoundary>
        </div>
      )}
      {tab === "barcodes" && (
        <div className="space-y-3">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-semibold text-slate-900">Inventory</h2>
            <ItemSubNav active="barcodes" />
          </div>
          <ErrorBoundary context="Barcode Labels">
            <BulkLabelsPage />
          </ErrorBoundary>
        </div>
      )}
      {tab === "vendors" && (
        <ErrorBoundary context="Vendors">
          <VendorList
            role={role}
            refreshKey={refreshKey}
            onCreate={() => setVendorCreateOpen(true)}
            onSelect={(v) => setVendorDetailTarget(v)}
            onRecordPayment={(v) => setVendorPaymentTarget(v)}
          />
        </ErrorBoundary>
      )}
      {tab === "customers" && (
        <ErrorBoundary context="Customers">
          <CustomerList
            role={role}
            refreshKey={refreshKey}
            onCreate={() => setCustomerCreateOpen(true)}
            onSelect={(c) => setCustomerDetailTarget(c)}
            onRecordPayment={(c) => setCustomerPaymentTarget(c)}
          />
        </ErrorBoundary>
      )}
      {tab === "settings" && (
        <RoleGuard minRole="owner">
          <ErrorBoundary context="Settings">
            <SettingsPage />
          </ErrorBoundary>
        </RoleGuard>
      )}
      {tab === "health" && (
        <RoleGuard minRole="owner">
          <ErrorBoundary context="Health">
            <MasterHealthPage />
          </ErrorBoundary>
        </RoleGuard>
      )}
      {tab === "logs" && (
        <RoleGuard minRole="owner">
          <ErrorBoundary context="Logs">
            <AdminLogs />
          </ErrorBoundary>
        </RoleGuard>
      )}

      {/* ── Vendor modals ──────────────────────────────── */}
      <InlineDialog
        open={vendorCreateOpen}
        onClose={() => setVendorCreateOpen(false)}
        title="Add Vendor"
      >
        <VendorForm
          mode="create"
          onSaved={(v) => { setVendorCreateOpen(false); setRefreshKey((k) => k + 1); setVendorDetailTarget(v); }}
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
            onSaved={(v) => { setVendorEditTarget(null); setRefreshKey((k) => k + 1); setVendorDetailTarget(v); }}
            onCancel={() => setVendorEditTarget(null)}
          />
        )}
      </InlineDialog>

      <InlineDialog
        open={!!vendorPaymentTarget}
        onClose={() => setVendorPaymentTarget(null)}
        title="Record vendor payment"
      >
        {vendorPaymentTarget && (
          <VendorPaymentForm
            vendor={vendorPaymentTarget}
            onSaved={() => { setVendorPaymentTarget(null); setRefreshKey((k) => k + 1); }}
            onCancel={() => setVendorPaymentTarget(null)}
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
          <VendorDetail
            vendor={vendorDetailTarget}
            onEdit={(v) => { setVendorDetailTarget(null); setVendorEditTarget(v); }}
            onRecordPayment={(v) => { setVendorDetailTarget(null); setVendorPaymentTarget(v); }}
          />
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
          onSaved={(c) => { setCustomerCreateOpen(false); setRefreshKey((k) => k + 1); setCustomerEditTarget(c); }}
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
            onSaved={(c) => { setCustomerEditTarget(null); setRefreshKey((k) => k + 1); }}
            onCancel={() => setCustomerEditTarget(null)}
          />
        )}
      </InlineDialog>

      <InlineDialog
        open={!!customerDetailTarget}
        onClose={() => setCustomerDetailTarget(null)}
        title="Customer Details"
        size="lg"
      >
        {customerDetailTarget && (
          <CustomerDetail
            customer={customerDetailTarget}
            onEdit={() => { setCustomerDetailTarget(null); setCustomerEditTarget(customerDetailTarget); }}
            onRecordPayment={() => { setCustomerDetailTarget(null); setCustomerPaymentTarget(customerDetailTarget); }}
          />
        )}
      </InlineDialog>

      <InlineDialog
        open={!!customerPaymentTarget}
        onClose={() => setCustomerPaymentTarget(null)}
        title="Record customer payment"
      >
        {customerPaymentTarget && (
          <CustomerPaymentForm
            customer={customerPaymentTarget}
            onSaved={() => { setCustomerPaymentTarget(null); setRefreshKey((k) => k + 1); }}
            onCancel={() => setCustomerPaymentTarget(null)}
          />
        )}
      </InlineDialog>
    </AppShell>
  );
}

function ItemSubNav({ active }: { active: "items" | "barcodes" }) {
  const tabs: ReadonlyArray<{ id: "items" | "barcodes"; label: string; href: string }> = [
    { id: "items", label: "Items", href: "#/items" },
    { id: "barcodes", label: "Barcode Labels", href: "#/barcodes" },
  ];
  return (
    <div className="flex gap-1 border-b border-slate-200">
      {tabs.map((t) => (
        <a
          key={t.id}
          href={t.href}
          className={`rounded-t-md border border-b-0 px-3 py-1.5 text-sm whitespace-nowrap transition-colors ${
            active === t.id
              ? "border-slate-200 bg-white font-medium text-slate-900"
              : "border-transparent text-slate-500 hover:bg-white hover:text-slate-700"
          }`}
        >
          {t.label}
        </a>
      ))}
    </div>
  );
}

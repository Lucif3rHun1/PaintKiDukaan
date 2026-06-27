import { tauriInvoke as invoke } from "./lib/security/tauri";
import logo from "./assets/logo-64.png";
import { Loader2 } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { z } from "zod";

/* ── Security UI ─────────────────────────────────────────── */
import { FirstLaunch } from "./lib/security/firstLaunch";
import { LockScreen } from "./lib/security/lockScreen";
import { RestoreFromRecovery } from "./lib/security/restoreFromRecovery";
import { type Bootstrap, useSecurity } from "./lib/security/state";
import { UserManagement } from "./lib/security/userManagement";
import { RoleGuard } from "./lib/security/roleGuard";

/* ── Domain UI (Slice B) ─────────────────────────────────── */
import { CustomerForm } from "./domain/customers/CustomerForm";
import { CustomerDetail } from "./domain/customers/CustomerDetail";
import { CustomerPaymentForm } from "./domain/customers/CustomerPaymentForm";
import { VendorForm } from "./domain/vendors/VendorForm";
import { VendorPaymentForm } from "./domain/vendors/VendorPaymentForm";
import { VendorDetail } from "./domain/vendors/VendorDetail";
import { listCustomerTypes } from "./domain/customerTypes/api";
/* ── POS UI (Slice C) ────────────────────────────────────── */
import { AppShell, type AppShellTab } from "./shell/AppShell";
import { InlineDialog } from "./components/ui/InlineDialog";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import type { Customer, CustomerType, Vendor } from "./domain/types";

/* Route pages are split into per-route Vite chunks via React.lazy so the
 * initial bundle ships only the shell + Dashboard. The `.then(m => ({ default: m.X }))`
 * wrapper is required because most pages use named exports. */
const ItemList = lazy(() =>
  import("./domain/items/ItemList").then((m) => ({ default: m.ItemList })),
);
const FormulasPage = lazy(() =>
  import("./domain/formulas/FormulasPage").then((m) => ({ default: m.FormulasPage })),
);
const FormulaDetailsPage = lazy(() =>
  import("./domain/formulas/FormulaDetailsPage").then((m) => ({ default: m.FormulaDetailsPage })),
);
const BulkLabelsPage = lazy(() =>
  import("./domain/items/BulkLabelsPage").then((m) => ({ default: m.BulkLabelsPage })),
);
const CustomerList = lazy(() =>
  import("./domain/customers/CustomerList").then((m) => ({ default: m.CustomerList })),
);
const VendorList = lazy(() =>
  import("./domain/vendors/VendorList").then((m) => ({ default: m.VendorList })),
);
const SalesPage = lazy(() => import("./pos/sales/SalesPage"));
const SalesListPage = lazy(() =>
  import("./pos/sales/SalesListPage").then((m) => ({ default: m.SalesListPage })),
);
const SaleDetailPage = lazy(() =>
  import("./pos/sales/SaleDetailPage").then((m) => ({ default: m.SaleDetailPage })),
);
const ReturnPage = lazy(() => import("./pos/sales/ReturnPage"));
const ReturnListPage = lazy(() =>
  import("./pos/sales/ReturnListPage").then((m) => ({ default: m.ReturnListPage })),
);
const ReturnDetailPage = lazy(() =>
  import("./pos/sales/ReturnDetailPage").then((m) => ({ default: m.ReturnDetailPage })),
);
const InwardPage = lazy(() => import("./pos/purchases/InwardPage"));
const InwardListPage = lazy(() =>
  import("./pos/purchases/InwardListPage").then((m) => ({ default: m.InwardListPage })),
);
const InwardDetailPage = lazy(() =>
  import("./pos/purchases/InwardDetailPage").then((m) => ({ default: m.InwardDetailPage })),
);
const ReportsPage = lazy(() =>
  import("./pos/salesReport/ReportsPage").then((m) => ({ default: m.default })),
);
const DayClosePage = lazy(() => import("./pos/dayClose/DayClosePage"));
const Dashboard = lazy(() =>
  import("./shell/routes/Dashboard").then((m) => ({ default: m.Dashboard })),
);
const SettingsPage = lazy(() =>
  import("./shell/routes/Settings").then((m) => ({ default: m.Settings })),
);
const AdminLogs = lazy(() =>
  import("./shell/routes/AdminLogs").then((m) => ({ default: m.AdminLogs })),
);
const MasterHealthPage = lazy(() =>
  import("./shell/health/MasterHealthPage").then((m) => ({ default: m.MasterHealthPage })),
);

const THIRTY_SECONDS = 30_000;
const FIFTEEN_MINUTES = 15 * 60 * 1_000;
const BOOTSTRAP_TIMEOUT_MS = 30_000;
const LOCKED_SESSION = { user: null, locked: true, pinRole: "real" as const };

const BootstrapUnlockedSchema = z.object({
  kind: z.literal("unlocked"),
  user: z.string().min(1).max(64),
  role: z.enum(["owner", "cashier", "stocker"]),
  pin_role: z.enum(["real", "decoy", "duress"]).optional(),
});

function RouteFallback() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex h-64 items-center justify-center text-sm text-muted-foreground"
    >
      <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
      Loading…
    </div>
  );
}

/* ── Hash routing ───────────────────────────────────────── */
const HASH_REDIRECTS: Record<string, string> = {
  "#/pos": "#/sales",
  "#/pos/inward": "#/inward",

  "#/pos/dayclose": "#/day-close",
  "#/pos/day-close": "#/day-close",
  "#/pos/reports": "#/reports/sales",
  "#/sales-report": "#/reports/sales",
};

function readTab(): AppShellTab {
  const h = typeof window !== "undefined" ? window.location.hash : "";
  if (h.startsWith("#/reports") || h.startsWith("#/sales-report")) return "sales-report";
  if (h.startsWith("#/day-close")) return "day-close";
  if (h.startsWith("#/inward")) return "inward";
  if (h.startsWith("#/sales")) return "sales";
  if (h.startsWith("#/formulas")) return "formulas";
  if (h.startsWith("#/barcodes")) return "barcodes";
  if (h.startsWith("#/items")) return "items";
  if (h.startsWith("#/customers")) return "customers";
  if (h.startsWith("#/vendors")) return "vendors";
  if (h.startsWith("#/settings")) return "settings";
  if (h.startsWith("#/health")) return "health";
  if (h.startsWith("#/logs")) return "logs";
  return "dashboard";
}

function readSalesSubRoute(): "list" | "new" | "return" | "return-list" | "return-detail" | "sale-detail" {
  const h = window.location.hash;
  if (h === "#/sales/new") return "new";
  if (h === "#/sales/return/new") return "return";
  const detailMatch = h.match(/^#\/sales\/return\/(.+)$/);
  if (h === "#/sales/return") return "return-list";
  if (detailMatch) return "return-detail";
  const saleDetail = h.match(/^#\/sales\/(\d+)$/);
  if (saleDetail) return "sale-detail";
  return "list";
}

function readFormulasSubRoute(): "list" | "detail" {
  const h = window.location.hash;
  if (h && /^#\/formulas\/\d+/.test(h)) return "detail";
  return "list";
}

function readInwardSubRoute(): "list" | "new" | "detail" {
  const h = window.location.hash;
  if (h === "#/inward/new") return "new";
  const detailMatch = h.match(/^#\/inward\/(\d+)$/);
  if (detailMatch) return "detail";
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
  const phase = useSecurity((s) => s.phase);
  const session = useSecurity((s) => s.session);
  const setPhase = useSecurity((s) => s.setPhase);
  const setSession = useSecurity((s) => s.setSession);
  const lastTouchAt = useRef(0);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [tab, setTab] = useState<AppShellTab>(readTab);
  const [salesRoute, setSalesRoute] = useState<"list" | "new" | "return" | "return-list" | "return-detail" | "sale-detail">(readSalesSubRoute);
  const [inwardRoute, setInwardRoute] = useState<"list" | "new" | "detail">(readInwardSubRoute);
  const [formulasRoute, setFormulasRoute] = useState<"list" | "detail">(readFormulasSubRoute);

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
      listCustomerTypes().then((d) => setCustomerTypes(d ?? [])).catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[App] failed to load customer types", e);
      });
    }
  }, [phase]);

  /* ── Bootstrap ─────────────────────────────────────────── */
  useEffect(() => {
    let cancelled = false;
    if (applyHashRedirect()) return;
    console.log("[BOOT] Calling app_bootstrap...");

    // Race the bootstrap against a timeout so the UI never hangs forever if
    // the backend is stuck on argon2 key derivation or DB contention.
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(
        `Startup timed out after ${BOOTSTRAP_TIMEOUT_MS / 1000}s. ` +
        "The shop data may be locked or the startup is taking too long."
      )), BOOTSTRAP_TIMEOUT_MS);
    });

    Promise.race([invoke<Bootstrap>("app_bootstrap"), timeout])
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
          const parsed = BootstrapUnlockedSchema.safeParse(b);
          if (!parsed.success) {
            console.error("[BOOT] Bootstrap validation failed:", parsed.error.format());
            setSession(LOCKED_SESSION);
            setPhase("locked");
            return;
          }
          const v = parsed.data;
          setSession({ user: { id: 0, name: v.user, role: v.role }, locked: false, pinRole: v.pin_role ?? "real" });
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
      setInwardRoute(readInwardSubRoute());
      setFormulasRoute(readFormulasSubRoute());
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  /* ── Activity tracking + idle auto-lock ───────────────── */
  // Single combined effect: the previous split added 6 window listeners
  // (3 for activity, 3 for idle-lock) on every phase change. Each mousemove
  // fired 6 callbacks. Consolidated to 3 callbacks per event.
  useEffect(() => {
    if (phase !== "unlocked") return;
    let idleTimer: ReturnType<typeof setTimeout>;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(async () => {
        try { await invoke("lock"); } finally {
          setSession(LOCKED_SESSION);
          setPhase("locked");
        }
      }, FIFTEEN_MINUTES);
    };
    const onActivity = () => {
      const now = Date.now();
      if (now - lastTouchAt.current >= THIRTY_SECONDS) {
        lastTouchAt.current = now;
        void invoke("touch_activity").catch(() => undefined);
      }
      resetIdle();
    };
    window.addEventListener("mousemove", onActivity, { passive: true });
    window.addEventListener("keydown", onActivity);
    window.addEventListener("click", onActivity);
    window.addEventListener("touchstart", onActivity, { passive: true });
    window.addEventListener("touchend", onActivity, { passive: true });
    window.addEventListener("scroll", onActivity, { passive: true });
    window.addEventListener("wheel", onActivity, { passive: true });
    resetIdle();
    return () => {
      clearTimeout(idleTimer);
      window.removeEventListener("mousemove", onActivity);
      window.removeEventListener("keydown", onActivity);
      window.removeEventListener("click", onActivity);
      window.removeEventListener("touchstart", onActivity);
      window.removeEventListener("touchend", onActivity);
      window.removeEventListener("scroll", onActivity);
      window.removeEventListener("wheel", onActivity);
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
            className="h-8 w-8 rounded-lg ring-1 ring-inset ring-border/40"
          />
          <Loader2 className="h-5 w-5 animate-spin text-indigo-400" aria-hidden="true" />
          <p className="text-sm text-zinc-400">Opening secure shop data…</p>
        </div>
      </main>
    );
  }

  if (phase === "first-launch") return <FirstLaunch />;
  if (phase === "locked") return <LockScreen />;
  if (phase === "restore-recovery") return <RestoreFromRecovery />;
  if (phase === "user-management") {
    return (
      <RoleGuard minRole="owner">
        <UserManagement />
      </RoleGuard>
    );
  }

  /* ── Unlocked: full app shell ──────────────────────────── */
  const user = session.user;
  const role = user?.role ?? "stocker";

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
          <Suspense fallback={<RouteFallback />}>
            <div className="animate-in fade-in motion-reduce:animate-none duration-200">
              <Dashboard />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {tab === "sales" && salesRoute === "new" ? (
        <ErrorBoundary context="Sales — new">
          <Suspense fallback={<RouteFallback />}>
            <div className="animate-in fade-in motion-reduce:animate-none duration-200">
              <SalesPage
                user={{ id: user?.id ?? 0, name: user?.name ?? "Owner", role }}
                onExit={() => (window.location.hash = "#/sales")}
              />
            </div>
          </Suspense>
        </ErrorBoundary>
      ) : null}
      {tab === "sales" && salesRoute === "return" ? (
        <ErrorBoundary context="Sales — return">
          <Suspense fallback={<RouteFallback />}>
            <div className="animate-in fade-in motion-reduce:animate-none duration-200">
              <ReturnPage
                user={{ id: user?.id ?? 0, name: user?.name ?? "Owner", role }}
                onBack={() => (window.location.hash = "#/sales/return")}
              />
            </div>
          </Suspense>
        </ErrorBoundary>
      ) : null}
      {tab === "sales" && salesRoute === "return-list" ? (
        <ErrorBoundary context="Sales — return list">
          <Suspense fallback={<RouteFallback />}>
            <div className="animate-in fade-in motion-reduce:animate-none duration-200">
              <ReturnListPage
                onCreate={() => (window.location.hash = "#/sales/return/new")}
                onSelect={(id) => (window.location.hash = `#/sales/return/${id}`)}
              />
            </div>
          </Suspense>
        </ErrorBoundary>
      ) : null}
      {tab === "sales" && salesRoute === "return-detail" ? (() => {
        const match = window.location.hash.match(/^#\/sales\/return\/(\d+)$/);
        const id = match ? Number(match[1]) : 0;
        return (
          <ErrorBoundary context="Sales — return detail">
            <Suspense fallback={<RouteFallback />}>
              <div className="animate-in fade-in motion-reduce:animate-none duration-200">
                <ReturnDetailPage
                  id={id}
                  onBack={() => (window.location.hash = "#/sales/return")}
                />
              </div>
            </Suspense>
          </ErrorBoundary>
        );
      })() : null}
      {tab === "sales" && salesRoute === "list" ? (
        <ErrorBoundary context="Sales — list">
          <Suspense fallback={<RouteFallback />}>
            <div className="animate-in fade-in motion-reduce:animate-none duration-200">
              <SalesListPage onCreate={() => (window.location.hash = "#/sales/new")} />
            </div>
          </Suspense>
        </ErrorBoundary>
      ) : null}
      {tab === "sales" && salesRoute === "sale-detail" ? (() => {
        const match = window.location.hash.match(/^#\/sales\/(\d+)$/);
        const id = match ? Number(match[1]) : 0;
        return (
          <ErrorBoundary context="Sales — detail">
            <Suspense fallback={<RouteFallback />}>
              <div className="animate-in fade-in motion-reduce:animate-none duration-200">
                <SaleDetailPage
                  id={id}
                  onBack={() => (window.location.hash = "#/sales")}
                />
              </div>
            </Suspense>
          </ErrorBoundary>
        );
      })() : null}
      {tab === "inward" && inwardRoute === "new" ? (
        <ErrorBoundary context="Inward — new">
          <Suspense fallback={<RouteFallback />}>
            <div className="animate-in fade-in motion-reduce:animate-none duration-200">
              <InwardPage user={{ id: user?.id ?? 0, name: user?.name ?? "Owner", role }} />
            </div>
          </Suspense>
        </ErrorBoundary>
      ) : null}
      {tab === "inward" && inwardRoute === "list" ? (
        <ErrorBoundary context="Inward — list">
          <Suspense fallback={<RouteFallback />}>
            <div className="animate-in fade-in motion-reduce:animate-none duration-200">
              <InwardListPage
                onCreate={() => (window.location.hash = "#/inward/new")}
                onSelect={(id) => (window.location.hash = `#/inward/${id}`)}
              />
            </div>
          </Suspense>
        </ErrorBoundary>
      ) : null}
      {tab === "inward" && inwardRoute === "detail" ? (() => {
        const match = window.location.hash.match(/^#\/inward\/(\d+)$/);
        const id = match ? Number(match[1]) : 0;
        return (
          <ErrorBoundary context="Inward — detail">
            <Suspense fallback={<RouteFallback />}>
              <div className="animate-in fade-in motion-reduce:animate-none duration-200">
                <InwardDetailPage
                  id={id}
                  onBack={() => (window.location.hash = "#/inward")}
                />
              </div>
            </Suspense>
          </ErrorBoundary>
        );
      })() : null}
      {tab === "sales-report" && (
        <RoleGuard minRole="stocker">
          <ErrorBoundary context="Reports">
            <Suspense fallback={<RouteFallback />}>
              <div className="animate-in fade-in motion-reduce:animate-none duration-200">
                {(() => {
                  const h = window.location.hash;
                  let section: "sales" | "inventory" | "customers" = "sales";
                  if (h.startsWith("#/reports/inventory")) section = "inventory";
                  else if (h.startsWith("#/reports/customers")) section = "customers";
                  return (
                    <ReportsPage
                      user={{ id: user?.id ?? 0, name: user?.name ?? "Owner", role }}
                      section={section}
                    />
                  );
                })()}
              </div>
            </Suspense>
          </ErrorBoundary>
        </RoleGuard>
      )}
      {tab === "day-close" && (
        <RoleGuard minRole="stocker">
          <ErrorBoundary context="Close Day">
            <Suspense fallback={<RouteFallback />}>
              <div className="animate-in fade-in motion-reduce:animate-none duration-200">
                <DayClosePage user={{ id: user?.id ?? 0, name: user?.name ?? "Owner", role }} />
              </div>
            </Suspense>
          </ErrorBoundary>
        </RoleGuard>
      )}
      {tab === "items" && (
        <div className="animate-in fade-in motion-reduce:animate-none space-y-3 duration-200">
          <h2 className="text-lg font-semibold text-slate-900">Inventory</h2>
          <ErrorBoundary context="Inventory">
            <Suspense fallback={<RouteFallback />}>
              <ItemList role={role} />
            </Suspense>
          </ErrorBoundary>
        </div>
      )}
      {tab === "formulas" && formulasRoute === "list" ? (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-slate-900">Shade formulas</h2>
          <ErrorBoundary context="Formulas">
            <Suspense fallback={<RouteFallback />}>
              <FormulasPage role={role} />
            </Suspense>
          </ErrorBoundary>
        </div>
      ) : null}
      {tab === "formulas" && formulasRoute === "detail" ? (() => {
        const match = window.location.hash.match(/^#\/formulas\/(\d+)/);
        const id = match ? Number(match[1]) : 0;
        return (
          <ErrorBoundary context="Formula details">
            <Suspense fallback={<RouteFallback />}>
              <FormulaDetailsPage
                id={id}
                role={role}
                onBack={() => (window.location.hash = "#/formulas")}
              />
            </Suspense>
          </ErrorBoundary>
        );
      })() : null}
      {tab === "barcodes" && (
        <div className="animate-in fade-in motion-reduce:animate-none space-y-3 duration-200">
          <h2 className="text-lg font-semibold text-slate-900">Barcode Labels</h2>
          <ErrorBoundary context="Barcode Labels">
            <Suspense fallback={<RouteFallback />}>
              <BulkLabelsPage />
            </Suspense>
          </ErrorBoundary>
        </div>
      )}
      {tab === "vendors" && (
        <ErrorBoundary context="Vendors">
          <Suspense fallback={<RouteFallback />}>
            <div className="animate-in fade-in motion-reduce:animate-none duration-200">
              <VendorList
                role={role}
                refreshKey={refreshKey}
                onCreate={() => setVendorCreateOpen(true)}
                onSelect={(v) => setVendorDetailTarget(v)}
                onRecordPayment={(v) => setVendorPaymentTarget(v)}
              />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {tab === "customers" && (
        <ErrorBoundary context="Customers">
          <Suspense fallback={<RouteFallback />}>
            <div className="animate-in fade-in motion-reduce:animate-none duration-200">
              <CustomerList
                role={role}
                refreshKey={refreshKey}
                onCreate={() => setCustomerCreateOpen(true)}
                onSelect={(c) => setCustomerDetailTarget(c)}
                onRecordPayment={(c) => setCustomerPaymentTarget(c)}
              />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {tab === "settings" && (
        <RoleGuard minRole="owner">
          <ErrorBoundary context="Settings">
            <Suspense fallback={<RouteFallback />}>
              <div className="animate-in fade-in motion-reduce:animate-none duration-200">
                <SettingsPage />
              </div>
            </Suspense>
          </ErrorBoundary>
        </RoleGuard>
      )}
      {tab === "health" && (
        <RoleGuard minRole="owner">
          <ErrorBoundary context="Health">
            <Suspense fallback={<RouteFallback />}>
              <div className="animate-in fade-in motion-reduce:animate-none duration-200">
                <MasterHealthPage />
              </div>
            </Suspense>
          </ErrorBoundary>
        </RoleGuard>
      )}
      {tab === "logs" && (
        <RoleGuard minRole="owner">
          <ErrorBoundary context="Logs">
            <Suspense fallback={<RouteFallback />}>
              <div className="animate-in fade-in motion-reduce:animate-none duration-200">
                <AdminLogs />
              </div>
            </Suspense>
          </ErrorBoundary>
        </RoleGuard>
      )}

      {/* ── Vendor modals ──────────────────────────────── */}
      <InlineDialog
        open={vendorCreateOpen}
        onClose={() => setVendorCreateOpen(false)}
        title="Add vendor"
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
        title="Edit vendor"
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
        title="Record Vendor payment"
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
        title="Vendor details"
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
        title="Add customer"
      >
        <CustomerForm
          mode="create"
          types={customerTypes}
          onSaved={(c) => { setCustomerCreateOpen(false); setRefreshKey((k) => k + 1); setCustomerEditTarget(c); }}
          onCancel={() => setCustomerCreateOpen(false)}
        />
      </InlineDialog>

      <InlineDialog
        open={!!customerEditTarget}
        onClose={() => setCustomerEditTarget(null)}
        title="Edit customer"
      >
        {customerEditTarget && (
          <CustomerForm
            mode="edit"
            initial={customerEditTarget}
            types={customerTypes}
            onSaved={(c) => { setCustomerEditTarget(null); setRefreshKey((k) => k + 1); }}
            onCancel={() => setCustomerEditTarget(null)}
          />
        )}
      </InlineDialog>

      <InlineDialog
        open={!!customerDetailTarget}
        onClose={() => setCustomerDetailTarget(null)}
        title="Customer details"
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
        title="Record Customer payment"
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

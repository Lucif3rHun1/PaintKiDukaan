import { tauriInvoke as invoke } from "./lib/security/tauri";
import { initSessionLog } from "./lib/security/sessionLog";
import {
  LayoutDashboard,
  Loader2,
  Lock,
  Package,
  ShieldCheck,
  ShoppingCart,
  Settings,
  Users,
  UserCheck,
  HeartPulse,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

/* ── Security UI ─────────────────────────────────────────── */
import { FirstLaunch } from "./lib/security/firstLaunch";
import { LockScreen } from "./lib/security/lockScreen";
import { RestoreFromRecovery } from "./lib/security/restoreFromRecovery";
import { type Bootstrap, useSecurity } from "./lib/security/state";
import { UserManagement } from "./lib/security/userManagement";

/* ── Domain UI (Slice B) ─────────────────────────────────── */
import { ItemList } from "./domain/items/ItemList";
import { CustomerList } from "./domain/customers/CustomerList";
import { VendorList } from "./domain/vendors/VendorList";
import { ManageTypes } from "./domain/customerTypes/ManageTypes";

/* ── POS UI (Slice C) ────────────────────────────────────── */
import PosLayout from "./pos/PosLayout";

/* ── Shell UI (Slice D) ──────────────────────────────────── */
import { Dashboard } from "./shell/routes/Dashboard";
import { Settings as SettingsPage } from "./shell/routes/Settings";
import { AdminLogs } from "./shell/routes/AdminLogs";
import { MasterHealthPage } from "./shell/health/MasterHealthPage";

const THIRTY_SECONDS = 30_000;
const FIFTEEN_MINUTES = 15 * 60 * 1_000;
const LOCKED_SESSION = { user: null, locked: true } as const;

/* ── Navigation tabs ─────────────────────────────────────── */
type AppTab =
  | "dashboard"
  | "pos"
  | "items"
  | "customers"
  | "vendors"
  | "settings"
  | "health"
  | "logs";

const NAV_ITEMS: { id: AppTab; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "pos", label: "POS", icon: ShoppingCart },
  { id: "items", label: "Items", icon: Package },
  { id: "customers", label: "Customers", icon: Users },
  { id: "vendors", label: "Vendors", icon: UserCheck },
  { id: "settings", label: "Settings", icon: Settings },
  { id: "health", label: "Health", icon: HeartPulse },
];

function readTab(): AppTab {
  const h = typeof window !== "undefined" ? window.location.hash : "";
  if (h.startsWith("#/pos")) return "pos";
  if (h.startsWith("#/items")) return "items";
  if (h.startsWith("#/customers")) return "customers";
  if (h.startsWith("#/vendors")) return "vendors";
  if (h.startsWith("#/settings")) return "settings";
  if (h.startsWith("#/health")) return "health";
  if (h.startsWith("#/logs")) return "logs";
  return "dashboard";
}

export default function App() {
  initSessionLog();
  const phase = useSecurity((s) => s.phase);
  const session = useSecurity((s) => s.session);
  const setPhase = useSecurity((s) => s.setPhase);
  const setSession = useSecurity((s) => s.setSession);
  const lastTouchAt = useRef(0);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [tab, setTab] = useState<AppTab>(readTab);

  /* ── Bootstrap ─────────────────────────────────────────── */
  useEffect(() => {
    let cancelled = false;
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

  function navigate(t: AppTab) {
    setTab(t);
    window.location.hash = t === "dashboard" ? "#/" : `#/${t}`;
  }

  /* ── Security phases ───────────────────────────────────── */
  if (phase === "loading") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-4 text-zinc-100">
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-white/10 bg-zinc-900/80 p-8 backdrop-blur">
          <Loader2 className="h-7 w-7 animate-spin text-indigo-400" aria-hidden="true" />
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
    <div className="flex h-screen overflow-hidden bg-zinc-950 text-zinc-100">
      {/* Sidebar */}
      <aside className="hidden w-56 shrink-0 border-r border-white/10 bg-zinc-900/80 md:flex md:flex-col">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-4">
          <ShieldCheck className="h-5 w-5 text-emerald-400" aria-hidden="true" />
          <span className="text-sm font-semibold tracking-tight text-white">PaintKiDukaan</span>
        </div>

        <nav className="flex-1 space-y-0.5 px-2 py-3">
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => navigate(id)}
              className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                tab === id
                  ? "bg-white/10 text-white font-medium"
                  : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              {label}
            </button>
          ))}
        </nav>

        <div className="border-t border-white/10 px-3 py-3">
          <div className="mb-2 truncate text-xs text-zinc-500">
            {user?.name ?? "Owner"} · {role}
          </div>
          <button
            type="button"
            onClick={lockNow}
            className="flex w-full items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-zinc-300 transition-colors hover:border-white/20 hover:bg-white/5"
          >
            <Lock className="h-4 w-4" aria-hidden="true" />
            Lock
          </button>
        </div>
      </aside>

      {/* Mobile top bar */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-white/10 bg-zinc-900/80 px-4 py-3 md:hidden">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-emerald-400" aria-hidden="true" />
            <span className="text-sm font-semibold text-white">PaintKiDukaan</span>
          </div>
          <button
            type="button"
            onClick={lockNow}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/5"
          >
            <Lock className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        {/* Mobile tab bar */}
        <nav className="flex overflow-x-auto border-b border-white/10 bg-zinc-900/60 px-2 py-1 md:hidden">
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => navigate(id)}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-colors ${
                tab === id
                  ? "bg-white/10 text-white font-medium"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              {label}
            </button>
          ))}
        </nav>

        {/* Content */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          {/* Bootstrap error */}
          {bootstrapError && (
            <p className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200" role="alert">
              {bootstrapError}
            </p>
          )}

          {tab === "dashboard" && <Dashboard />}
          {tab === "pos" && (
            <PosLayout
              user={{ id: user?.id ?? 0, name: user?.name ?? "Owner", role }}
              onLock={lockNow}
            />
          )}
          {tab === "items" && (
            <div className="space-y-4">
              <h2 className="text-xl font-semibold">Inventory</h2>
              <ItemList role={role} />
            </div>
          )}
          {tab === "customers" && (
            <div className="space-y-4">
              <h2 className="text-xl font-semibold">Customers</h2>
              <CustomerList role={role} />
            </div>
          )}
          {tab === "vendors" && (
            <div className="space-y-4">
              <h2 className="text-xl font-semibold">Vendors</h2>
              <VendorList role={role} />
            </div>
          )}
          {tab === "settings" && <SettingsPage />}
          {tab === "health" && <MasterHealthPage />}
          {tab === "logs" && <AdminLogs />}
        </main>
      </div>
    </div>
  );
}
